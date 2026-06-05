import { pool } from '../db/index.js';

async function migrateBundles() {
  console.log('Starting bundles migration...');

  try {
    // Create bundles table
    await pool.query(`
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
      )
    `);
    console.log('✓ Created bundles table');

    // Create bundle_items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bundle_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bundle_id UUID NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
        card_id UUID REFERENCES cards(id) ON DELETE SET NULL,
        card_name VARCHAR(255) NOT NULL,
        card_set_code VARCHAR(20),
        card_image_path TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    console.log('✓ Created bundle_items table');

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_bundles_slug ON bundles(slug);
      CREATE INDEX IF NOT EXISTS idx_bundles_category ON bundles(category);
      CREATE INDEX IF NOT EXISTS idx_bundles_is_active ON bundles(is_active);
      CREATE INDEX IF NOT EXISTS idx_bundles_is_featured ON bundles(is_featured);
      CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle_id ON bundle_items(bundle_id);
      CREATE INDEX IF NOT EXISTS idx_bundle_items_card_id ON bundle_items(card_id);
    `);
    console.log('✓ Created indexes');

    console.log('\n✅ Bundles migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

migrateBundles();

