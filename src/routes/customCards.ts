import { Router, Request, Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { pool } from '../db/index.js';
import { authenticateAdmin, AuthRequest } from '../middleware/auth.js';

const router = Router();

// Configure multer for image uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, WebP, and GIF are allowed.'));
    }
  },
});

// Ensure custom cards directory exists
const ensureCustomCardsDir = async () => {
  const dir = path.join(process.cwd(), 'data', 'custom-cards');
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

// ============ PUBLIC ROUTES ============

// GET /api/custom-cards - List all active custom cards (public)
router.get('/', async (req: Request, res: Response) => {
  try {
    const { theme, search, page = '1', limit = '24' } = req.query;
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    let query = `
      SELECT 
        cc.*,
        c.name as original_card_name,
        c.set_code as original_set_code,
        c.set_name as original_set_name,
        c.type_line as original_type_line,
        c.rarity as original_rarity,
        c.colors as original_colors
      FROM custom_cards cc
      LEFT JOIN cards c ON cc.original_card_id = c.id
      WHERE cc.is_active = true
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (theme) {
      query += ` AND cc.theme = $${paramIndex}`;
      params.push(theme);
      paramIndex++;
    }

    if (search) {
      query += ` AND (cc.name ILIKE $${paramIndex} OR cc.display_name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Get total count
    const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) FROM');
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    // Get paginated results
    query += ` ORDER BY cc.sort_order ASC, cc.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limitNum, offset);

    const result = await pool.query(query, params);

    res.json({
      cards: result.rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Error fetching custom cards:', error);
    res.status(500).json({ error: 'Failed to fetch custom cards' });
  }
});

// GET /api/custom-cards/themes - Get list of all themes
router.get('/themes', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT theme, COUNT(*) as card_count
      FROM custom_cards
      WHERE is_active = true AND theme IS NOT NULL
      GROUP BY theme
      ORDER BY card_count DESC
    `);

    res.json({ themes: result.rows });
  } catch (error) {
    console.error('Error fetching themes:', error);
    res.status(500).json({ error: 'Failed to fetch themes' });
  }
});

// GET /api/custom-cards/:id - Get single custom card
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        cc.*,
        c.name as original_card_name,
        c.set_code as original_set_code,
        c.set_name as original_set_name,
        c.type_line as original_type_line,
        c.rarity as original_rarity,
        c.colors as original_colors
      FROM custom_cards cc
      LEFT JOIN cards c ON cc.original_card_id = c.id
      WHERE cc.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Custom card not found' });
    }

    res.json({ card: result.rows[0] });
  } catch (error) {
    console.error('Error fetching custom card:', error);
    res.status(500).json({ error: 'Failed to fetch custom card' });
  }
});

// ============ ADMIN ROUTES ============

// GET /api/custom-cards/admin/list - List all custom cards (admin)
router.get('/admin/list', authenticateAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        cc.*,
        c.name as original_card_name
      FROM custom_cards cc
      LEFT JOIN cards c ON cc.original_card_id = c.id
      ORDER BY cc.theme ASC NULLS LAST, cc.sort_order ASC, cc.created_at DESC
    `);

    res.json({ cards: result.rows });
  } catch (error) {
    console.error('Error fetching custom cards:', error);
    res.status(500).json({ error: 'Failed to fetch custom cards' });
  }
});

// POST /api/custom-cards/admin/create - Create a custom card
router.post('/admin/create', authenticateAdmin, upload.single('image'), async (req: Request, res: Response) => {
  try {
    const {
      name,
      displayName,
      theme,
      description,
      originalCardId,
      price,
      setCode,
      setName,
      typeLine,
      rarity,
      colors,
      isActive,
      isFeatured,
      sortOrder,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Image is required' });
    }

    // Process and save image
    const dir = await ensureCustomCardsDir();
    const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
    const imagePath = `custom-cards/${filename}`;
    const fullPath = path.join(dir, filename);

    await sharp(req.file.buffer)
      .resize(745, 1040, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toFile(fullPath);

    // Parse colors if string
    let parsedColors = colors;
    if (typeof colors === 'string') {
      try {
        parsedColors = JSON.parse(colors);
      } catch {
        parsedColors = colors.split(',').map((c: string) => c.trim()).filter(Boolean);
      }
    }

    // Validate originalCardId exists in cards table (must be a standard Scryfall card, not a custom card)
    let validOriginalCardId = null;
    if (originalCardId) {
      const cardCheck = await pool.query('SELECT id FROM cards WHERE id = $1', [originalCardId]);
      if (cardCheck.rows.length > 0) {
        validOriginalCardId = originalCardId;
      }
      // If not found, silently ignore - the card might be a custom card or invalid
    }

    const result = await pool.query(`
      INSERT INTO custom_cards (
        name, display_name, theme, description, original_card_id,
        image_path, price, set_code, set_name, type_line, rarity, colors,
        is_active, is_featured, sort_order
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `, [
      name,
      displayName || null,
      theme || null,
      description || null,
      validOriginalCardId,
      imagePath,
      price || 0.50,
      setCode || null,
      setName || null,
      typeLine || null,
      rarity || null,
      parsedColors ? JSON.stringify(parsedColors) : null,
      isActive !== 'false',
      isFeatured === 'true',
      sortOrder || 0,
    ]);

    res.json({ card: result.rows[0] });
  } catch (error) {
    console.error('Error creating custom card:', error);
    res.status(500).json({ error: 'Failed to create custom card' });
  }
});

// PUT /api/custom-cards/admin/:id - Update a custom card
router.put('/admin/:id', authenticateAdmin, upload.single('image'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      displayName,
      theme,
      description,
      originalCardId,
      price,
      setCode,
      setName,
      typeLine,
      rarity,
      colors,
      isActive,
      isFeatured,
      sortOrder,
    } = req.body;

    // Check if card exists
    const existingResult = await pool.query(
      'SELECT * FROM custom_cards WHERE id = $1',
      [id]
    );

    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Custom card not found' });
    }

    let imagePath = existingResult.rows[0].image_path;

    // Process new image if uploaded
    if (req.file) {
      const dir = await ensureCustomCardsDir();
      const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
      imagePath = `custom-cards/${filename}`;
      const fullPath = path.join(dir, filename);

      await sharp(req.file.buffer)
        .resize(745, 1040, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toFile(fullPath);

      // Delete old image
      try {
        const oldPath = path.join(process.cwd(), 'data', existingResult.rows[0].image_path);
        await fs.unlink(oldPath);
      } catch (err) {
        // Ignore deletion errors
      }
    }

    // Parse colors if string
    let parsedColors = colors;
    if (typeof colors === 'string') {
      try {
        parsedColors = JSON.parse(colors);
      } catch {
        parsedColors = colors.split(',').map((c: string) => c.trim()).filter(Boolean);
      }
    }

    // Validate originalCardId exists in cards table (must be a standard Scryfall card, not a custom card)
    let validOriginalCardId = null;
    if (originalCardId) {
      const cardCheck = await pool.query('SELECT id FROM cards WHERE id = $1', [originalCardId]);
      if (cardCheck.rows.length > 0) {
        validOriginalCardId = originalCardId;
      }
      // If not found, silently ignore - the card might be a custom card or invalid
    }

    const result = await pool.query(`
      UPDATE custom_cards SET
        name = $1,
        display_name = $2,
        theme = $3,
        description = $4,
        original_card_id = $5,
        image_path = $6,
        price = $7,
        set_code = $8,
        set_name = $9,
        type_line = $10,
        rarity = $11,
        colors = $12,
        is_active = $13,
        is_featured = $14,
        sort_order = $15,
        updated_at = NOW()
      WHERE id = $16
      RETURNING *
    `, [
      name,
      displayName || null,
      theme || null,
      description || null,
      validOriginalCardId,
      imagePath,
      price || 0.50,
      setCode || null,
      setName || null,
      typeLine || null,
      rarity || null,
      parsedColors ? JSON.stringify(parsedColors) : null,
      isActive !== 'false',
      isFeatured === 'true',
      sortOrder || 0,
      id,
    ]);

    res.json({ card: result.rows[0] });
  } catch (error) {
    console.error('Error updating custom card:', error);
    res.status(500).json({ error: 'Failed to update custom card' });
  }
});

// DELETE /api/custom-cards/admin/:id - Delete a custom card
router.delete('/admin/:id', authenticateAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get card to delete image
    const cardResult = await pool.query(
      'SELECT image_path FROM custom_cards WHERE id = $1',
      [id]
    );

    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Custom card not found' });
    }

    // Delete from database
    await pool.query('DELETE FROM custom_cards WHERE id = $1', [id]);

    // Delete image file
    try {
      const imagePath = path.join(process.cwd(), 'data', cardResult.rows[0].image_path);
      await fs.unlink(imagePath);
    } catch (err) {
      // Ignore deletion errors
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting custom card:', error);
    res.status(500).json({ error: 'Failed to delete custom card' });
  }
});

// POST /api/custom-cards/admin/bulk-upload - Bulk upload custom cards
interface MulterRequest extends Request {
  files?: Express.Multer.File[];
}

router.post('/admin/bulk-upload', authenticateAdmin, upload.array('images', 100), async (req: Request, res: Response) => {
  try {
    const { theme, price } = req.body;
    const files = (req as MulterRequest).files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded' });
    }

    const dir = await ensureCustomCardsDir();
    const createdCards: any[] = [];
    const errors: string[] = [];

    for (const file of files) {
      try {
        // Extract card name from filename (remove extension)
        const originalName = file.originalname;
        const cardName = originalName.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');

        // Process and save image
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
        const imagePath = `custom-cards/${filename}`;
        const fullPath = path.join(dir, filename);

        await sharp(file.buffer)
          .resize(745, 1040, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toFile(fullPath);

        // Try to find matching original card
        const matchResult = await pool.query(
          `SELECT id, type_line, rarity, colors FROM cards WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [cardName]
        );

        const originalCard = matchResult.rows[0] || null;

        const result = await pool.query(`
          INSERT INTO custom_cards (
            name, theme, image_path, price, original_card_id,
            type_line, rarity, colors, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
          RETURNING *
        `, [
          cardName,
          theme || null,
          imagePath,
          price || 0.50,
          originalCard?.id || null,
          originalCard?.type_line || null,
          originalCard?.rarity || null,
          originalCard?.colors || null,
        ]);

        createdCards.push(result.rows[0]);
      } catch (err: any) {
        errors.push(`Failed to process ${file.originalname}: ${err.message}`);
      }
    }

    res.json({
      success: true,
      created: createdCards.length,
      errors: errors.length > 0 ? errors : undefined,
      cards: createdCards,
    });
  } catch (error) {
    console.error('Error bulk uploading:', error);
    res.status(500).json({ error: 'Failed to bulk upload' });
  }
});

export default router;
