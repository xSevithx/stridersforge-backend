import bcrypt from 'bcrypt';
import { pool } from '../db/index.js';
import config from '../config/index.js';

const seed = async () => {
  console.log('🌱 Starting database seed...');
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Create default admin user
    const passwordHash = await bcrypt.hash(config.adminPassword, 10);
    
    await client.query(`
      INSERT INTO admin_users (email, password_hash, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        updated_at = NOW();
    `, [config.adminEmail, passwordHash, 'Admin']);
    
    console.log(`✅ Admin user created: ${config.adminEmail}`);

    // Create default pricing config
    const pricingDefaults = [
      { name: 'single_card_price', description: 'Price per single card', value: '0.50' },
      { name: 'foil_upcharge', description: 'Additional charge per card for foil finish', value: '2.00' },
      { name: 'deck_60_price', description: 'Flat price for a 60-card deck', value: '100.00' },
      { name: 'deck_100_price', description: 'Flat price for a 100-card deck (Commander)', value: '100.00' },
      { name: 'bulk_discount_threshold', description: 'Number of cards to trigger bulk discount', value: '20' },
      { name: 'bulk_discount_percent', description: 'Discount percentage for bulk orders', value: '10' },
    ];

    for (const pricing of pricingDefaults) {
      await client.query(`
        INSERT INTO pricing_config (name, description, value)
        VALUES ($1, $2, $3)
        ON CONFLICT (name) DO NOTHING;
      `, [pricing.name, pricing.description, pricing.value]);
    }
    
    console.log('✅ Default pricing configuration created');

    await client.query('COMMIT');
    console.log('✅ Database seed completed successfully!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

seed().catch(console.error);

