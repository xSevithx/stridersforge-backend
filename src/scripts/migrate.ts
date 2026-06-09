import { pool } from '../db/index.js';

const migrate = async () => {
  console.log('🚀 Starting database migration...');
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Create enums
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE order_status AS ENUM ('pending', 'processing', 'printing', 'shipped', 'delivered', 'cancelled');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await client.query(`
      DO $$ BEGIN
        CREATE TYPE card_game AS ENUM ('magic', 'pokemon', 'yugioh', 'other');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // Create cards table
    await client.query(`
      CREATE TABLE IF NOT EXISTS cards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scryfall_id VARCHAR(255) UNIQUE,
        name VARCHAR(255) NOT NULL,
        set_code VARCHAR(20),
        set_name VARCHAR(255),
        collector_number VARCHAR(50),
        rarity VARCHAR(50),
        mana_cost VARCHAR(100),
        type_line VARCHAR(255),
        oracle_text TEXT,
        colors JSONB,
        color_identity JSONB,
        image_url TEXT,
        local_image_path TEXT,
        game card_game NOT NULL DEFAULT 'magic',
        prices JSONB,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create index on cards
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
      CREATE INDEX IF NOT EXISTS idx_cards_set_code ON cards(set_code);
      CREATE INDEX IF NOT EXISTS idx_cards_game ON cards(game);
      CREATE INDEX IF NOT EXISTS idx_cards_scryfall_id ON cards(scryfall_id);
    `);

    // Create orders table
    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tracking_code VARCHAR(50) NOT NULL UNIQUE,
        customer_email VARCHAR(255) NOT NULL,
        customer_name VARCHAR(255),
        shipping_address JSONB,
        status order_status NOT NULL DEFAULT 'pending',
        subtotal DECIMAL(10, 2) NOT NULL,
        discount DECIMAL(10, 2) NOT NULL DEFAULT 0,
        total DECIMAL(10, 2) NOT NULL,
        stripe_session_id VARCHAR(255),
        stripe_payment_intent_id VARCHAR(255),
        is_paid BOOLEAN NOT NULL DEFAULT false,
        paid_at TIMESTAMP,
        notes TEXT,
        status_history JSONB DEFAULT '[]',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create indexes on orders
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orders_tracking_code ON orders(tracking_code);
      CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders(customer_email);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
    `);

    // Create order_items table
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        card_id UUID REFERENCES cards(id),
        card_name VARCHAR(255) NOT NULL,
        card_set_code VARCHAR(20),
        card_image_path TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        price_per_card DECIMAL(10, 2) NOT NULL,
        total_price DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create index on order_items
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    `);

    // Create admin_users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        is_active BOOLEAN NOT NULL DEFAULT true,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create pricing_config table
    await client.query(`
      CREATE TABLE IF NOT EXISTS pricing_config (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        value DECIMAL(10, 2) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create bundles table
    await client.query(`
      CREATE TABLE IF NOT EXISTS bundles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL UNIQUE,
        description TEXT,
        category VARCHAR(100),
        price DECIMAL(10, 2) NOT NULL,
        original_price DECIMAL(10, 2),
        image_url TEXT,
        card_count INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        is_featured BOOLEAN NOT NULL DEFAULT false,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create indexes on bundles
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bundles_slug ON bundles(slug);
      CREATE INDEX IF NOT EXISTS idx_bundles_is_active ON bundles(is_active);
      CREATE INDEX IF NOT EXISTS idx_bundles_is_featured ON bundles(is_featured);
    `);

    // Create bundle_items table
    await client.query(`
      CREATE TABLE IF NOT EXISTS bundle_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bundle_id UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
        card_id UUID REFERENCES cards(id),
        card_name VARCHAR(255) NOT NULL,
        card_set_code VARCHAR(20),
        card_image_path TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create index on bundle_items
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle_id ON bundle_items(bundle_id);
    `);

    // Create custom_cards table (for custom proxy art)
    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_cards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        display_name VARCHAR(255),
        theme VARCHAR(100),
        description TEXT,
        original_card_id UUID REFERENCES cards(id) ON DELETE SET NULL,
        image_path TEXT NOT NULL,
        price DECIMAL(10, 2) NOT NULL DEFAULT 0.50,
        set_code VARCHAR(20),
        set_name VARCHAR(255),
        type_line VARCHAR(255),
        rarity VARCHAR(50),
        colors JSONB,
        is_active BOOLEAN NOT NULL DEFAULT true,
        is_featured BOOLEAN NOT NULL DEFAULT false,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create indexes on custom_cards
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_custom_cards_name ON custom_cards(name);
      CREATE INDEX IF NOT EXISTS idx_custom_cards_theme ON custom_cards(theme);
      CREATE INDEX IF NOT EXISTS idx_custom_cards_is_active ON custom_cards(is_active);
      CREATE INDEX IF NOT EXISTS idx_custom_cards_original_card_id ON custom_cards(original_card_id);
    `);

    // Add custom_card_id to bundle_items if not exists
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE bundle_items ADD COLUMN custom_card_id UUID REFERENCES custom_cards(id) ON DELETE SET NULL;
      EXCEPTION
        WHEN duplicate_column THEN null;
      END $$;
    `);

    // Create pending_checkouts table (temporary storage for cart data during Stripe checkout)
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_checkouts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cart_data JSONB NOT NULL,
        customer_email VARCHAR(255),
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Create index on pending_checkouts for cleanup
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pending_checkouts_expires_at ON pending_checkouts(expires_at);
    `);

    // Create site_settings table for admin-configurable settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS site_settings (
        name VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Insert default settings if they don't exist
    await client.query(`
      INSERT INTO site_settings (name, value, description)
      VALUES 
        ('checkout_enabled', 'true', 'Whether checkout is enabled for customers'),
        ('checkout_disabled_message', 'Our order queue is currently full. Please check back soon!', 'Message shown when checkout is disabled')
      ON CONFLICT (name) DO NOTHING;
    `);

    // Add custom_card_id to order_items if not exists
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE order_items ADD COLUMN custom_card_id UUID REFERENCES custom_cards(id) ON DELETE SET NULL;
      EXCEPTION
        WHEN duplicate_column THEN null;
      END $$;
    `);

    // Create index on order_items custom_card_id
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_order_items_custom_card_id ON order_items(custom_card_id);
    `);

    // Add finish column to order_items for foil/non-foil tracking
    await client.query(`
      ALTER TABLE order_items
        ADD COLUMN IF NOT EXISTS finish VARCHAR(100) NOT NULL DEFAULT 'nonfoil';
    `);

    // Widen finish column if it was previously created as VARCHAR(10)
    await client.query(`
      ALTER TABLE order_items
        ALTER COLUMN finish TYPE VARCHAR(100);
    `);

    // Create custom_products table for non-card items
    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        image_path TEXT,
        price DECIMAL(10, 2) NOT NULL,
        stock_quantity INTEGER,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Add foil_upcharge pricing config if not exists (legacy, kept for fallback)
    await client.query(`
      INSERT INTO pricing_config (name, description, value)
      VALUES ('foil_upcharge', 'Additional charge per card for foil finish', '2.00')
      ON CONFLICT (name) DO NOTHING;
    `);

    // Create foil_options table for multiple configurable foil types
    await client.query(`
      CREATE TABLE IF NOT EXISTS foil_options (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) NOT NULL UNIQUE,
        upcharge DECIMAL(10, 2) NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Seed default foil option if table is empty
    await client.query(`
      INSERT INTO foil_options (name, slug, upcharge, sort_order)
      SELECT 'Regular Foil', 'regular-foil', 2.00, 0
      WHERE NOT EXISTS (SELECT 1 FROM foil_options);
    `);

    await client.query('COMMIT');
    console.log('✅ Database migration completed successfully!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

migrate().catch(console.error);

