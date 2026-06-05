import { Router, Request, Response } from 'express';
import { pool } from '../db/index.js';
import { authenticateAdmin, AuthRequest } from '../middleware/auth.js';

const router = Router();

// Helper to generate slug
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// =====================
// PUBLIC ROUTES
// =====================

// GET /api/bundles - List all active bundles (public)
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, name, slug, description, category, price, original_price,
        image_url, card_count, is_featured, sort_order
      FROM bundles
      WHERE is_active = true
      ORDER BY is_featured DESC, sort_order ASC, name ASC
    `);

    res.json({ bundles: result.rows });
  } catch (error) {
    console.error('Error fetching bundles:', error);
    res.status(500).json({ error: 'Failed to fetch bundles' });
  }
});

// GET /api/bundles/:slug - Get single bundle with items (public)
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;

    // Check if it's a UUID (for admin) or slug (for public)
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
    
    const bundleResult = await pool.query(
      `SELECT * FROM bundles WHERE ${isUUID ? 'id' : 'slug'} = $1`,
      [slug]
    );

    if (bundleResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    const bundle = bundleResult.rows[0];

    // Get bundle items (join with both cards and custom_cards tables)
    const itemsResult = await pool.query(`
      SELECT 
        bi.id, bi.card_id, bi.custom_card_id, bi.card_name, bi.card_set_code, 
        bi.card_image_path, bi.quantity,
        COALESCE(c.image_url, NULL) as image_url, 
        COALESCE(c.local_image_path, cc.image_path) as local_image_path, 
        COALESCE(c.rarity, cc.rarity) as rarity, 
        COALESCE(c.type_line, cc.type_line) as type_line,
        CASE WHEN bi.custom_card_id IS NOT NULL THEN true ELSE false END as is_custom
      FROM bundle_items bi
      LEFT JOIN cards c ON bi.card_id = c.id
      LEFT JOIN custom_cards cc ON bi.custom_card_id = cc.id
      WHERE bi.bundle_id = $1
      ORDER BY bi.card_name ASC
    `, [bundle.id]);

    res.json({
      bundle: {
        ...bundle,
        items: itemsResult.rows,
      },
    });
  } catch (error) {
    console.error('Error fetching bundle:', error);
    res.status(500).json({ error: 'Failed to fetch bundle' });
  }
});

// =====================
// ADMIN ROUTES
// =====================

// GET /api/bundles/admin/list - List all bundles for admin
router.get('/admin/list', authenticateAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM bundles
      ORDER BY sort_order ASC, name ASC
    `);

    res.json({ bundles: result.rows });
  } catch (error) {
    console.error('Error fetching bundles:', error);
    res.status(500).json({ error: 'Failed to fetch bundles' });
  }
});

// POST /api/bundles/admin/create - Create new bundle
router.post('/admin/create', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, description, category, price, originalPrice, imageUrl, isFeatured, sortOrder } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    let slug = generateSlug(name);
    
    // Check for duplicate slug and add suffix if needed
    const existing = await pool.query('SELECT id FROM bundles WHERE slug = $1', [slug]);
    if (existing.rows.length > 0) {
      slug = `${slug}-${Date.now()}`;
    }

    const result = await pool.query(`
      INSERT INTO bundles (name, slug, description, category, price, original_price, image_url, is_featured, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [name, slug, description, category, price, originalPrice, imageUrl, isFeatured || false, sortOrder || 0]);

    res.json({ bundle: result.rows[0] });
  } catch (error) {
    console.error('Error creating bundle:', error);
    res.status(500).json({ error: 'Failed to create bundle' });
  }
});

// PUT /api/bundles/admin/:id - Update bundle
router.put('/admin/:id', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, category, price, originalPrice, imageUrl, isActive, isFeatured, sortOrder } = req.body;

    const result = await pool.query(`
      UPDATE bundles
      SET 
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        category = COALESCE($3, category),
        price = COALESCE($4, price),
        original_price = $5,
        image_url = $6,
        is_active = COALESCE($7, is_active),
        is_featured = COALESCE($8, is_featured),
        sort_order = COALESCE($9, sort_order),
        updated_at = NOW()
      WHERE id = $10
      RETURNING *
    `, [name, description, category, price, originalPrice, imageUrl, isActive, isFeatured, sortOrder, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    res.json({ bundle: result.rows[0] });
  } catch (error) {
    console.error('Error updating bundle:', error);
    res.status(500).json({ error: 'Failed to update bundle' });
  }
});

// DELETE /api/bundles/admin/:id - Delete bundle
router.delete('/admin/:id', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query('DELETE FROM bundles WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting bundle:', error);
    res.status(500).json({ error: 'Failed to delete bundle' });
  }
});

// POST /api/bundles/admin/:id/items - Add item to bundle
router.post('/admin/:id/items', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { cardId, cardName, cardSetCode, cardImagePath, quantity, isCustom } = req.body;

    if (!cardName) {
      return res.status(400).json({ error: 'Card name is required' });
    }

    // Check bundle exists
    const bundleCheck = await pool.query('SELECT id FROM bundles WHERE id = $1', [id]);
    if (bundleCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    // Add item - use custom_card_id for custom cards, card_id for standard cards
    let result;
    if (isCustom) {
      result = await pool.query(`
        INSERT INTO bundle_items (bundle_id, custom_card_id, card_name, card_set_code, card_image_path, quantity)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [id, cardId || null, cardName, cardSetCode, cardImagePath, quantity || 1]);
    } else {
      result = await pool.query(`
        INSERT INTO bundle_items (bundle_id, card_id, card_name, card_set_code, card_image_path, quantity)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [id, cardId || null, cardName, cardSetCode, cardImagePath, quantity || 1]);
    }

    // Update card count
    await pool.query(`
      UPDATE bundles 
      SET card_count = (
        SELECT COALESCE(SUM(quantity), 0) FROM bundle_items WHERE bundle_id = $1
      ),
      updated_at = NOW()
      WHERE id = $1
    `, [id]);

    res.json({ item: result.rows[0] });
  } catch (error) {
    console.error('Error adding item to bundle:', error);
    res.status(500).json({ error: 'Failed to add item to bundle' });
  }
});

// PUT /api/bundles/admin/:id/items/:itemId - Update item quantity
router.put('/admin/:id/items/:itemId', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id, itemId } = req.params;
    const { quantity } = req.body;

    const result = await pool.query(`
      UPDATE bundle_items
      SET quantity = $1
      WHERE id = $2 AND bundle_id = $3
      RETURNING *
    `, [quantity, itemId, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Update card count
    await pool.query(`
      UPDATE bundles 
      SET card_count = (
        SELECT COALESCE(SUM(quantity), 0) FROM bundle_items WHERE bundle_id = $1
      ),
      updated_at = NOW()
      WHERE id = $1
    `, [id]);

    res.json({ item: result.rows[0] });
  } catch (error) {
    console.error('Error updating item:', error);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE /api/bundles/admin/:id/items/:itemId - Remove item from bundle
router.delete('/admin/:id/items/:itemId', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id, itemId } = req.params;

    const result = await pool.query(
      'DELETE FROM bundle_items WHERE id = $1 AND bundle_id = $2 RETURNING id',
      [itemId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Update card count
    await pool.query(`
      UPDATE bundles 
      SET card_count = (
        SELECT COALESCE(SUM(quantity), 0) FROM bundle_items WHERE bundle_id = $1
      ),
      updated_at = NOW()
      WHERE id = $1
    `, [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing item:', error);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

// POST /api/bundles/admin/:id/duplicate - Duplicate a bundle
router.post('/admin/:id/duplicate', authenticateAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Get original bundle
    const bundleResult = await pool.query('SELECT * FROM bundles WHERE id = $1', [id]);
    if (bundleResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bundle not found' });
    }

    const original = bundleResult.rows[0];
    const newSlug = `${original.slug}-copy-${Date.now()}`;
    const newName = `${original.name} (Copy)`;

    // Create new bundle
    const newBundleResult = await pool.query(`
      INSERT INTO bundles (name, slug, description, category, price, original_price, image_url, card_count, is_active, is_featured, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, false, $9)
      RETURNING *
    `, [newName, newSlug, original.description, original.category, original.price, original.original_price, original.image_url, original.card_count, original.sort_order]);

    const newBundle = newBundleResult.rows[0];

    // Copy items
    await pool.query(`
      INSERT INTO bundle_items (bundle_id, card_id, card_name, card_set_code, card_image_path, quantity)
      SELECT $1, card_id, card_name, card_set_code, card_image_path, quantity
      FROM bundle_items
      WHERE bundle_id = $2
    `, [newBundle.id, id]);

    res.json({ bundle: newBundle });
  } catch (error) {
    console.error('Error duplicating bundle:', error);
    res.status(500).json({ error: 'Failed to duplicate bundle' });
  }
});

export default router;

