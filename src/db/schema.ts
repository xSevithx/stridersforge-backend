import { pgTable, text, timestamp, decimal, integer, boolean, jsonb, uuid, varchar, pgEnum } from 'drizzle-orm/pg-core';

// Enums
export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'processing', 
  'printing',
  'shipped',
  'delivered',
  'cancelled'
]);

export const cardGameEnum = pgEnum('card_game', [
  'magic',
  'pokemon',
  'yugioh',
  'other'
]);

// Cards table
export const cards = pgTable('cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  scryfallId: varchar('scryfall_id', { length: 255 }).unique(),
  name: varchar('name', { length: 255 }).notNull(),
  setCode: varchar('set_code', { length: 20 }),
  setName: varchar('set_name', { length: 255 }),
  collectorNumber: varchar('collector_number', { length: 50 }),
  rarity: varchar('rarity', { length: 50 }),
  manaCost: varchar('mana_cost', { length: 100 }),
  typeLine: varchar('type_line', { length: 255 }),
  oracleText: text('oracle_text'),
  colors: jsonb('colors').$type<string[]>(),
  colorIdentity: jsonb('color_identity').$type<string[]>(),
  imageUrl: text('image_url'),
  localImagePath: text('local_image_path'),
  game: cardGameEnum('game').notNull().default('magic'),
  prices: jsonb('prices').$type<Record<string, string | null>>(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Orders table
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  trackingCode: varchar('tracking_code', { length: 50 }).notNull().unique(),
  customerEmail: varchar('customer_email', { length: 255 }).notNull(),
  customerName: varchar('customer_name', { length: 255 }),
  shippingAddress: jsonb('shipping_address').$type<{
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }>(),
  status: orderStatusEnum('status').notNull().default('pending'),
  subtotal: decimal('subtotal', { precision: 10, scale: 2 }).notNull(),
  discount: decimal('discount', { precision: 10, scale: 2 }).notNull().default('0'),
  total: decimal('total', { precision: 10, scale: 2 }).notNull(),
  stripeSessionId: varchar('stripe_session_id', { length: 255 }),
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  isPaid: boolean('is_paid').notNull().default(false),
  paidAt: timestamp('paid_at'),
  notes: text('notes'),
  statusHistory: jsonb('status_history').$type<{
    status: string;
    timestamp: string;
    note?: string;
  }[]>().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Order Items table
export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  cardId: uuid('card_id').references(() => cards.id),
  customCardId: uuid('custom_card_id'), // References custom_cards(id) in DB
  cardName: varchar('card_name', { length: 255 }).notNull(),
  cardSetCode: varchar('card_set_code', { length: 20 }),
  cardImagePath: text('card_image_path'),
  quantity: integer('quantity').notNull().default(1),
  pricePerCard: decimal('price_per_card', { precision: 10, scale: 2 }).notNull(),
  totalPrice: decimal('total_price', { precision: 10, scale: 2 }).notNull(),
  finish: varchar('finish', { length: 100 }).notNull().default('nonfoil'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Admin Users table
export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }),
  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Pricing Config table (for dynamic pricing)
export const pricingConfig = pgTable('pricing_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  description: text('description'),
  value: decimal('value', { precision: 10, scale: 2 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Bundles table (for preset card collections)
export const bundles = pgTable('bundles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  description: text('description'),
  category: varchar('category', { length: 100 }), // e.g., 'commander', 'modern', 'vintage', 'custom'
  price: decimal('price', { precision: 10, scale: 2 }).notNull(),
  originalPrice: decimal('original_price', { precision: 10, scale: 2 }), // For showing discount
  imageUrl: text('image_url'), // Featured image for the bundle
  cardCount: integer('card_count').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  isFeatured: boolean('is_featured').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Bundle Items table (cards in each bundle)
export const bundleItems = pgTable('bundle_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  bundleId: uuid('bundle_id').notNull().references(() => bundles.id, { onDelete: 'cascade' }),
  cardId: uuid('card_id').references(() => cards.id, { onDelete: 'set null' }),
  customCardId: uuid('custom_card_id'), // Reference to custom card (added later to avoid circular ref)
  cardName: varchar('card_name', { length: 255 }).notNull(),
  cardSetCode: varchar('card_set_code', { length: 20 }),
  cardImagePath: text('card_image_path'),
  quantity: integer('quantity').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Custom Cards table (for custom proxy art)
export const customCards = pgTable('custom_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(), // Original card name for search
  displayName: varchar('display_name', { length: 255 }), // Custom display name (optional)
  theme: varchar('theme', { length: 100 }), // e.g., 'anime', 'gremlins', 'retro'
  description: text('description'),
  originalCardId: uuid('original_card_id').references(() => cards.id, { onDelete: 'set null' }),
  imagePath: text('image_path').notNull(),
  price: decimal('price', { precision: 10, scale: 2 }).notNull().default('0.50'),
  setCode: varchar('set_code', { length: 20 }),
  setName: varchar('set_name', { length: 255 }),
  typeLine: varchar('type_line', { length: 255 }),
  rarity: varchar('rarity', { length: 50 }),
  colors: jsonb('colors').$type<string[]>(),
  isActive: boolean('is_active').notNull().default(true),
  isFeatured: boolean('is_featured').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Custom Products table (non-card items for sale)
export const customProducts = pgTable('custom_products', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  imagePath: text('image_path'),
  price: decimal('price', { precision: 10, scale: 2 }).notNull(),
  stockQuantity: integer('stock_quantity'), // null = unlimited
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Pending Checkouts table (temporary storage for cart data during Stripe checkout)
export const pendingCheckouts = pgTable('pending_checkouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  cartData: jsonb('cart_data').notNull(), // Full cart data including items, bundles, totals
  customerEmail: varchar('customer_email', { length: 255 }),
  expiresAt: timestamp('expires_at').notNull(), // Auto-cleanup after expiration
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Types
export type Card = typeof cards.$inferSelect;
export type NewCard = typeof cards.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;
export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;
export type PricingConfig = typeof pricingConfig.$inferSelect;
export type NewPricingConfig = typeof pricingConfig.$inferInsert;
export type Bundle = typeof bundles.$inferSelect;
export type NewBundle = typeof bundles.$inferInsert;
export type BundleItem = typeof bundleItems.$inferSelect;
export type NewBundleItem = typeof bundleItems.$inferInsert;
export type CustomCard = typeof customCards.$inferSelect;
export type NewCustomCard = typeof customCards.$inferInsert;
export type CustomProduct = typeof customProducts.$inferSelect;
export type NewCustomProduct = typeof customProducts.$inferInsert;
export type PendingCheckout = typeof pendingCheckouts.$inferSelect;
export type NewPendingCheckout = typeof pendingCheckouts.$inferInsert;

