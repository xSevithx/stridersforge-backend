import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/stridersforge',
  
  // JWT
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiresIn: '7d' as const,
  
  // Stripe
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  
  // Frontend
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  
  // Admin
  adminEmail: process.env.ADMIN_EMAIL || 'admin@stridersforge.com',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  
  // Paths
  dataDir: path.join(process.cwd(), 'data'),
  cardImagesDir: path.join(process.cwd(), 'data', 'card-images'),
  
  // Pricing (configurable)
  pricing: {
    singleCardPrice: parseFloat(process.env.SINGLE_CARD_PRICE || '0.50'),
    deck60Price: parseFloat(process.env.DECK_60_PRICE || '100.00'),
    deck100Price: parseFloat(process.env.DECK_100_PRICE || '100.00'),
    bulkDiscountThreshold: parseInt(process.env.BULK_DISCOUNT_THRESHOLD || '20', 10),
    bulkDiscountPercent: parseFloat(process.env.BULK_DISCOUNT_PERCENT || '10'),
  },
};

export default config;

