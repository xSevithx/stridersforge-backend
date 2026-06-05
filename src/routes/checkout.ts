import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { pool } from '../db/index.js';
import config from '../config/index.js';

const router = Router();

const stripe = new Stripe(config.stripeSecretKey, {
  apiVersion: '2023-10-16',
});

interface CartItem {
  cardId: string;
  cardName: string;
  cardSetCode: string;
  cardImagePath: string;
  quantity: number;
  isCustom?: boolean;
  price?: string;
  finish?: 'nonfoil' | 'foil';
}

interface CartBundle {
  bundleId: string;
  bundleName: string;
  bundlePrice: string;
  quantity: number;
  items?: Array<{
    card_id?: string | null;
    custom_card_id?: string | null;
    is_custom?: boolean;
    card_name: string;
    card_set_code?: string;
    card_image_path?: string;
    local_image_path?: string;
    quantity: number;
  }>;
}

interface PendingOrderItem {
  cardId?: string | null;
  customCardId?: string | null;
  isCustom?: boolean;
  cardName: string;
  cardSetCode?: string;
  cardImagePath?: string;
  quantity: number;
  pricePerCard: string;
  totalPrice: string;
  fromBundle?: string | null;
  finish?: 'nonfoil' | 'foil';
}

/** Map cart line items to valid FK refs; always keep denormalized name/image on the row. */
const resolveOrderItemRefs = async (
  client: { query: typeof pool.query },
  items: PendingOrderItem[]
): Promise<Array<{ cardId: string | null; customCardId: string | null }>> => {
  const candidateIds = new Set<string>();
  for (const item of items) {
    if (item.customCardId) candidateIds.add(item.customCardId);
    if (item.cardId) candidateIds.add(item.cardId);
  }

  const validCardIds = new Set<string>();
  const validCustomCardIds = new Set<string>();

  if (candidateIds.size > 0) {
    const ids = [...candidateIds];
    const [cardsResult, customResult] = await Promise.all([
      client.query('SELECT id FROM cards WHERE id = ANY($1::uuid[])', [ids]),
      client.query('SELECT id FROM custom_cards WHERE id = ANY($1::uuid[])', [ids]),
    ]);
    for (const row of cardsResult.rows) validCardIds.add(row.id);
    for (const row of customResult.rows) validCustomCardIds.add(row.id);
  }

  return items.map((item) => {
    if (item.isCustom || item.customCardId) {
      const customId = item.customCardId || item.cardId || null;
      return {
        cardId: null,
        customCardId: customId && validCustomCardIds.has(customId) ? customId : null,
      };
    }

    if (item.cardId && validCardIds.has(item.cardId)) {
      return { cardId: item.cardId, customCardId: null };
    }

    if (item.cardId && validCustomCardIds.has(item.cardId)) {
      return { cardId: null, customCardId: item.cardId };
    }

    if (item.cardId) {
      console.warn(
        `Order item "${item.cardName}": reference ${item.cardId} not in cards/custom_cards; storing snapshot only`
      );
    }

    return { cardId: null, customCardId: null };
  });
};

// Get pricing from database
const getPricing = async () => {
  const result = await pool.query('SELECT name, value FROM pricing_config WHERE is_active = true');
  return result.rows.reduce((acc, row) => {
    acc[row.name] = parseFloat(row.value);
    return acc;
  }, {} as Record<string, number>);
};

// Check if checkout is enabled
const getCheckoutStatus = async () => {
  const result = await pool.query(
    "SELECT name, value FROM site_settings WHERE name IN ('checkout_enabled', 'checkout_disabled_message')"
  );
  const settings = result.rows.reduce((acc, row) => {
    acc[row.name] = row.value;
    return acc;
  }, {} as Record<string, string>);
  
  return {
    enabled: settings.checkout_enabled !== 'false',
    message: settings.checkout_disabled_message || 'Checkout is currently unavailable. Please try again later.',
  };
};

// Calculate cart totals (cards only - legacy)
const calculateTotals = async (items: CartItem[]) => {
  const pricing = await getPricing();
  const totalCards = items.reduce((sum, item) => sum + item.quantity, 0);
  
  let subtotal = 0;
  let discount = 0;
  let deckType: string | null = null;

  // Check if this is a deck order (60 or 100 cards)
  if (totalCards === 60) {
    subtotal = pricing['deck_60_price'] || 100;
    deckType = 'deck_60';
  } else if (totalCards === 100) {
    subtotal = pricing['deck_100_price'] || 100;
    deckType = 'deck_100';
  } else {
    // Calculate singles pricing
    const singlePrice = pricing['single_card_price'] || 0.5;
    subtotal = totalCards * singlePrice;

    // Apply bulk discount
    const bulkThreshold = pricing['bulk_discount_threshold'] || 20;
    const bulkDiscountPercent = pricing['bulk_discount_percent'] || 10;

    if (totalCards >= bulkThreshold && totalCards !== 60 && totalCards !== 100) {
      discount = subtotal * (bulkDiscountPercent / 100);
    }
  }

  const total = subtotal - discount;

  return {
    subtotal: subtotal.toFixed(2),
    discount: discount.toFixed(2),
    total: total.toFixed(2),
    totalCards,
    deckType,
    pricing,
  };
};

// Calculate cart totals with bundles
const calculateTotalsWithBundles = async (items: CartItem[], bundles: CartBundle[]) => {
  const pricing = await getPricing();
  
  // Calculate bundle totals
  let bundleTotal = 0;
  let bundleCardCount = 0;
  for (const bundle of bundles) {
    bundleTotal += parseFloat(bundle.bundlePrice) * bundle.quantity;
    // Count cards in bundles (we need to look up the bundle to get card count)
    if (bundle.items) {
      bundleCardCount += bundle.items.reduce((sum, item) => sum + item.quantity, 0) * bundle.quantity;
    }
  }

  // Separate custom cards (use their individual price) from standard cards
  let customCardTotal = 0;
  let standardCardCount = 0;
  
  for (const item of items) {
    if (item.isCustom && item.price) {
      // Custom cards use their configured price
      customCardTotal += parseFloat(item.price) * item.quantity;
    } else {
      // Standard cards count toward bulk pricing
      standardCardCount += item.quantity;
    }
  }
  
  // Calculate standard card totals
  let standardCardSubtotal = 0;
  let discount = 0;
  let deckType: string | null = null;

  if (standardCardCount > 0) {
    // Check if standard cards form a deck order
    if (standardCardCount === 60) {
      standardCardSubtotal = pricing['deck_60_price'] || 100;
      deckType = 'deck_60';
    } else if (standardCardCount === 100) {
      standardCardSubtotal = pricing['deck_100_price'] || 100;
      deckType = 'deck_100';
    } else {
      const singlePrice = pricing['single_card_price'] || 0.5;
      standardCardSubtotal = standardCardCount * singlePrice;

      // Apply bulk discount for standard cards only
      const bulkThreshold = pricing['bulk_discount_threshold'] || 20;
      const bulkDiscountPercent = pricing['bulk_discount_percent'] || 10;

      if (standardCardCount >= bulkThreshold) {
        discount = standardCardSubtotal * (bulkDiscountPercent / 100);
      }
    }
  }

  const cardSubtotal = customCardTotal + standardCardSubtotal;
  const individualCardCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = bundleTotal + cardSubtotal;
  const total = bundleTotal + cardSubtotal - discount;
  const totalCards = bundleCardCount + individualCardCount;

  return {
    bundleTotal: bundleTotal.toFixed(2),
    cardSubtotal: cardSubtotal.toFixed(2),
    customCardTotal: customCardTotal.toFixed(2),
    standardCardTotal: standardCardSubtotal.toFixed(2),
    subtotal: subtotal.toFixed(2),
    discount: discount.toFixed(2),
    total: total.toFixed(2),
    totalCards,
    bundleCardCount,
    individualCardCount,
    standardCardCount,
    deckType,
    pricing,
  };
};

// GET /api/checkout/pricing - Get current pricing
router.get('/pricing', async (_req: Request, res: Response) => {
  try {
    const pricing = await getPricing();
    res.json({ pricing });
  } catch (error) {
    console.error('Error fetching pricing:', error);
    res.status(500).json({ error: 'Failed to fetch pricing' });
  }
});

// GET /api/checkout/status - Check if checkout is enabled (public)
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await getCheckoutStatus();
    res.json(status);
  } catch (error) {
    console.error('Error fetching checkout status:', error);
    res.status(500).json({ error: 'Failed to fetch checkout status' });
  }
});

// POST /api/checkout/calculate - Calculate cart totals
router.post('/calculate', async (req: Request, res: Response) => {
  try {
    const { items } = req.body as { items: CartItem[] };

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items are required' });
    }

    const totals = await calculateTotals(items);

    res.json({
      subtotal: totals.subtotal,
      discount: totals.discount,
      total: totals.total,
      totalCards: totals.totalCards,
      deckType: totals.deckType,
    });
  } catch (error) {
    console.error('Error calculating totals:', error);
    res.status(500).json({ error: 'Failed to calculate totals' });
  }
});

// POST /api/checkout/create-session - Create Stripe checkout session
router.post('/create-session', async (req: Request, res: Response) => {
  try {
    // Check if checkout is enabled
    const checkoutStatus = await getCheckoutStatus();
    if (!checkoutStatus.enabled) {
      return res.status(503).json({ 
        error: 'Checkout is currently disabled',
        message: checkoutStatus.message,
      });
    }

    const { items = [], bundles = [], customerEmail } = req.body as {
      items?: CartItem[];
      bundles?: CartBundle[];
      customerEmail?: string;
    };

    const hasItems = items.length > 0;
    const hasBundles = bundles.length > 0;

    if (!hasItems && !hasBundles) {
      return res.status(400).json({ error: 'Items or bundles are required' });
    }

    const totals = await calculateTotalsWithBundles(items, bundles);

    // Build description
    const descriptionParts: string[] = [];
    if (hasBundles) {
      const bundleCount = bundles.reduce((sum, b) => sum + b.quantity, 0);
      descriptionParts.push(`${bundleCount} Bundle${bundleCount > 1 ? 's' : ''}`);
    }
    if (hasItems) {
      if (totals.deckType === 'deck_60') {
        descriptionParts.push('60-Card Deck');
      } else if (totals.deckType === 'deck_100') {
        descriptionParts.push('100-Card Commander Deck');
      } else if (totals.individualCardCount > 0) {
        descriptionParts.push(`${totals.individualCardCount} Card${totals.individualCardCount > 1 ? 's' : ''}`);
      }
    }
    const description = descriptionParts.join(' + ') || `${totals.totalCards} Cards`;

    // Store cart data for webhook (including bundle items expanded)
    const allOrderItems: any[] = [];

    // Add individual cards
    for (const item of items) {
      const pricePerCard = totals.individualCardCount > 0 
        ? (parseFloat(totals.cardSubtotal) / totals.individualCardCount) 
        : 0;
      const isCustom = !!item.isCustom;
      allOrderItems.push({
        cardId: isCustom ? null : item.cardId,
        customCardId: isCustom ? item.cardId : null,
        isCustom,
        cardName: item.cardName,
        cardSetCode: item.cardSetCode,
        cardImagePath: item.cardImagePath,
        quantity: item.quantity,
        pricePerCard: pricePerCard.toFixed(2),
        totalPrice: (pricePerCard * item.quantity).toFixed(2),
        fromBundle: null,
        finish: item.finish || 'nonfoil',
      });
    }

    // Add bundle items (expanded)
    for (const bundle of bundles) {
      const bundlePricePerCard = bundle.items && bundle.items.length > 0
        ? parseFloat(bundle.bundlePrice) / bundle.items.reduce((sum, i) => sum + i.quantity, 0)
        : 0;

      if (bundle.items) {
        for (const bundleItem of bundle.items) {
          const isCustom = !!(bundleItem.is_custom || bundleItem.custom_card_id);
          // For each bundle quantity, add the items
          for (let q = 0; q < bundle.quantity; q++) {
            allOrderItems.push({
              cardId: isCustom ? null : (bundleItem.card_id || null),
              customCardId: isCustom ? (bundleItem.custom_card_id || null) : null,
              isCustom,
              cardName: bundleItem.card_name,
              cardSetCode: bundleItem.card_set_code || '',
              cardImagePath: bundleItem.local_image_path || bundleItem.card_image_path || '',
              quantity: bundleItem.quantity,
              pricePerCard: bundlePricePerCard.toFixed(2),
              totalPrice: (bundlePricePerCard * bundleItem.quantity).toFixed(2),
              fromBundle: bundle.bundleName,
            });
          }
        }
      }
    }

    const cartData = {
      items: allOrderItems,
      bundles: bundles.map(b => ({
        bundleId: b.bundleId,
        bundleName: b.bundleName,
        bundlePrice: b.bundlePrice,
        quantity: b.quantity,
      })),
      subtotal: totals.subtotal,
      discount: totals.discount,
      total: totals.total,
    };

    // Store cart data in database (Stripe metadata has 500 char limit per value)
    // Cart data is stored temporarily and expires after 24 hours
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
    const pendingCheckoutResult = await pool.query(
      `INSERT INTO pending_checkouts (cart_data, customer_email, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [JSON.stringify(cartData), customerEmail || null, expiresAt]
    );
    const pendingCheckoutId = pendingCheckoutResult.rows[0].id;

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: customerEmail,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Striders Forge Cards',
              description,
            },
            unit_amount: Math.round(parseFloat(totals.total) * 100), // Stripe uses cents
          },
          quantity: 1,
        },
      ],
      shipping_address_collection: {
        allowed_countries: ['US'],
      },
      metadata: {
        pendingCheckoutId, // Store only the reference ID (fits within 500 char limit)
      },
      success_url: `${config.frontendUrl}/order/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.frontendUrl}/cart`,
    });

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/checkout/webhook - Stripe webhook
router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      config.stripeWebhookSecret
    );
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const sessionFromEvent = event.data.object as Stripe.Checkout.Session;
      // Retrieve the full session - shipping_details and customer_details are included automatically
      const session = await stripe.checkout.sessions.retrieve(sessionFromEvent.id);
      await handleCheckoutComplete(session);
      break;
    }
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// Handle completed checkout
const handleCheckoutComplete = async (session: Stripe.Checkout.Session) => {
  const pendingCheckoutId = session.metadata?.pendingCheckoutId;
  if (!pendingCheckoutId) {
    console.error('No pending checkout ID found in session metadata');
    return;
  }

  // Idempotency: Stripe may retry the webhook after a partial failure
  const existingOrder = await pool.query(
    'SELECT id, tracking_code FROM orders WHERE stripe_session_id = $1',
    [session.id]
  );
  if (existingOrder.rows.length > 0) {
    console.log(`Order already exists for session ${session.id}: ${existingOrder.rows[0].tracking_code}`);
    await pool.query('DELETE FROM pending_checkouts WHERE id = $1', [pendingCheckoutId]);
    return;
  }

  const client = await pool.connect();

  try {
    const pendingCheckoutResult = await client.query(
      'SELECT cart_data FROM pending_checkouts WHERE id = $1',
      [pendingCheckoutId]
    );

    if (pendingCheckoutResult.rows.length === 0) {
      console.error('Pending checkout not found:', pendingCheckoutId);
      return;
    }

    const cartData = pendingCheckoutResult.rows[0].cart_data;
    
    if (!cartData.items || cartData.items.length === 0) {
      console.error('No cart data found in pending checkout');
      return;
    }

    const orderItems: PendingOrderItem[] = cartData.items;
    const itemRefs = await resolveOrderItemRefs(client, orderItems);

    await client.query('BEGIN');

    // Generate tracking code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let trackingCode = 'SF-';
    for (let i = 0; i < 8; i++) {
      trackingCode += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const statusHistory = [{
      status: 'pending',
      timestamp: new Date().toISOString(),
      note: 'Order placed - Payment received',
    }];

    // Get shipping address
    const shippingAddress = session.shipping_details?.address ? {
      line1: session.shipping_details.address.line1 || '',
      line2: session.shipping_details.address.line2 || undefined,
      city: session.shipping_details.address.city || '',
      state: session.shipping_details.address.state || '',
      postalCode: session.shipping_details.address.postal_code || '',
      country: session.shipping_details.address.country || '',
    } : null;

    // Create order
    const orderResult = await client.query(`
      INSERT INTO orders (
        tracking_code, customer_email, customer_name, shipping_address,
        status, subtotal, discount, total, stripe_session_id, stripe_payment_intent_id,
        is_paid, paid_at, status_history
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `, [
      trackingCode,
      session.customer_email || session.customer_details?.email || '',
      session.shipping_details?.name || session.customer_details?.name || '',
      JSON.stringify(shippingAddress),
      'pending',
      cartData.subtotal,
      cartData.discount,
      cartData.total,
      session.id,
      session.payment_intent,
      true,
      new Date(),
      JSON.stringify(statusHistory),
    ]);

    const orderId = orderResult.rows[0].id;

    // Create order items (card_id/custom_card_id optional; name/image/prices always stored)
    for (let i = 0; i < orderItems.length; i++) {
      const item = orderItems[i];
      const refs = itemRefs[i];
      await client.query(`
        INSERT INTO order_items (
          order_id, card_id, custom_card_id, card_name, card_set_code, card_image_path,
          quantity, price_per_card, total_price, finish
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        orderId,
        refs.cardId,
        refs.customCardId,
        item.cardName,
        item.cardSetCode || '',
        item.cardImagePath || '',
        item.quantity,
        item.pricePerCard,
        item.totalPrice,
        item.finish || 'nonfoil',
      ]);
    }

    // Delete the pending checkout now that order is created
    await client.query('DELETE FROM pending_checkouts WHERE id = $1', [pendingCheckoutId]);

    await client.query('COMMIT');
    console.log(`✅ Order created: ${trackingCode}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error handling checkout complete:', error);
    throw error;
  } finally {
    client.release();
  }
};

// GET /api/checkout/session/:sessionId - Get session details (for success page)
router.get('/session/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Find the order by stripe session ID
    const orderResult = await pool.query(
      'SELECT tracking_code, customer_email, total FROM orders WHERE stripe_session_id = $1',
      [sessionId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      order: orderResult.rows[0],
      paymentStatus: session.payment_status,
    });
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

export default router;

