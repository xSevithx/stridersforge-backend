import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/index.js';

const router = Router();

// Generate a random tracking code
const generateTrackingCode = (): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MTG-';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

// GET /api/orders/track/:trackingCode - Public order tracking
router.get('/track/:trackingCode', async (req: Request, res: Response) => {
  try {
    const { trackingCode } = req.params;

    const orderResult = await pool.query(`
      SELECT 
        id, tracking_code, customer_name, status, subtotal, discount, total,
        is_paid, paid_at, status_history, created_at, updated_at
      FROM orders
      WHERE tracking_code = $1
    `, [trackingCode.toUpperCase()]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // Get order items
    const itemsResult = await pool.query(`
      SELECT card_name, card_set_code, card_image_path, quantity, price_per_card, total_price
      FROM order_items
      WHERE order_id = $1
    `, [order.id]);

    res.json({
      order: {
        trackingCode: order.tracking_code,
        customerName: order.customer_name,
        status: order.status,
        subtotal: order.subtotal,
        discount: order.discount,
        total: order.total,
        isPaid: order.is_paid,
        paidAt: order.paid_at,
        statusHistory: order.status_history,
        createdAt: order.created_at,
        items: itemsResult.rows,
      },
    });
  } catch (error) {
    console.error('Error tracking order:', error);
    res.status(500).json({ error: 'Failed to track order' });
  }
});

// POST /api/orders - Create new order (internal use, called after Stripe checkout)
router.post('/', async (req: Request, res: Response) => {
  const client = await pool.connect();

  try {
    const {
      customerEmail,
      customerName,
      shippingAddress,
      items,
      subtotal,
      discount,
      total,
      stripeSessionId,
    } = req.body;

    await client.query('BEGIN');

    const trackingCode = generateTrackingCode();
    const statusHistory = [{
      status: 'pending',
      timestamp: new Date().toISOString(),
      note: 'Order created',
    }];

    // Create order
    const orderResult = await client.query(`
      INSERT INTO orders (
        tracking_code, customer_email, customer_name, shipping_address,
        status, subtotal, discount, total, stripe_session_id, status_history
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [
      trackingCode,
      customerEmail,
      customerName,
      JSON.stringify(shippingAddress),
      'pending',
      subtotal,
      discount,
      total,
      stripeSessionId,
      JSON.stringify(statusHistory),
    ]);

    const orderId = orderResult.rows[0].id;

    // Create order items
    for (const item of items) {
      await client.query(`
        INSERT INTO order_items (
          order_id, card_id, card_name, card_set_code, card_image_path,
          quantity, price_per_card, total_price
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        orderId,
        item.cardId,
        item.cardName,
        item.cardSetCode,
        item.cardImagePath,
        item.quantity,
        item.pricePerCard,
        item.totalPrice,
      ]);
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      trackingCode,
      orderId,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

export default router;

