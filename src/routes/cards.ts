import { Router, Request, Response } from 'express';
import { pool } from '../db/index.js';

const router = Router();

// GET /api/cards - List cards with pagination and filters
// includeCustom=true will include custom proxy cards in results
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      page = '1',
      limit = '20',
      search,
      set,
      rarity,
      colors,
      game = 'magic',
      sortBy = 'name',
      sortOrder = 'asc',
      includeCustom = 'true', // Include custom cards by default
      customOnly = 'false', // Only show custom cards
      theme, // Filter custom cards by theme
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const offset = (pageNum - 1) * limitNum;

    const showCustom = includeCustom === 'true';
    const onlyCustom = customOnly === 'true';

    // Validate sort
    const validSortFields = ['name', 'set_code', 'rarity', 'created_at'];
    const sortField = validSortFields.includes(sortBy as string) ? sortBy : 'name';
    const sortDir = sortOrder === 'desc' ? 'DESC' : 'ASC';

    if (onlyCustom) {
      // Only fetch custom cards
      let customWhere: string[] = ['is_active = true'];
      const customParams: any[] = [];
      let customParamIndex = 1;

      if (search) {
        customWhere.push(`(name ILIKE $${customParamIndex} OR COALESCE(display_name, '') ILIKE $${customParamIndex})`);
        customParams.push(`%${search}%`);
        customParamIndex++;
      }

      if (theme) {
        customWhere.push(`theme = $${customParamIndex++}`);
        customParams.push(theme);
      }

      if (rarity) {
        customWhere.push(`rarity = $${customParamIndex++}`);
        customParams.push(rarity);
      }

      if (colors) {
        const colorList = (colors as string).split(',').filter(c => c.trim());
        if (colorList.length > 0) {
          customWhere.push(`colors ?| $${customParamIndex++}::text[]`);
          customParams.push(colorList);
        }
      }

      const customWhereClause = `WHERE ${customWhere.join(' AND ')}`;

      // Get count
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM custom_cards ${customWhereClause}`,
        customParams
      );
      const total = parseInt(countResult.rows[0].count, 10);

      // Get custom cards
      const customQuery = `
        SELECT 
          id, name, display_name, theme, description, image_path as local_image_path,
          set_code, set_name, type_line, rarity, colors, price,
          'custom' as card_type, is_featured
        FROM custom_cards
        ${customWhereClause}
        ORDER BY ${sortField === 'set_code' ? 'theme' : sortField} ${sortDir}
        LIMIT $${customParamIndex++} OFFSET $${customParamIndex++}
      `;

      const result = await pool.query(customQuery, [...customParams, limitNum, offset]);

      // Transform results
      const cards = result.rows.map(row => ({
        ...row,
        is_custom: true,
        scryfall_id: null,
        collector_number: null,
        mana_cost: null,
        oracle_text: null,
        color_identity: null,
        image_url: null,
        game: 'magic',
        prices: null,
      }));

      return res.json({
        cards,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    }

    // Standard cards query
    let whereConditions: string[] = ['is_active = true'];
    const params: any[] = [];
    let paramIndex = 1;

    // Game filter
    whereConditions.push(`game = $${paramIndex++}`);
    params.push(game);

    // Search filter
    if (search) {
      whereConditions.push(`(
        name ILIKE $${paramIndex} OR 
        COALESCE(type_line, '') ILIKE $${paramIndex} OR 
        COALESCE(oracle_text, '') ILIKE $${paramIndex}
      )`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Set filter
    if (set) {
      whereConditions.push(`set_code = $${paramIndex++}`);
      params.push(set);
    }

    // Rarity filter
    if (rarity) {
      whereConditions.push(`rarity = $${paramIndex++}`);
      params.push(rarity);
    }

    // Colors filter
    if (colors) {
      const colorList = (colors as string).split(',').filter(c => c.trim());
      if (colorList.length > 0) {
        whereConditions.push(`colors ?| $${paramIndex++}::text[]`);
        params.push(colorList);
      }
    }

    const whereClause = whereConditions.length > 0 
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Get standard cards count
    const countQuery = `SELECT COUNT(*) FROM cards ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    let total = parseInt(countResult.rows[0].count, 10);

    // Also count matching custom cards if including them
    let customTotal = 0;
    if (showCustom) {
      let customWhere = 'WHERE is_active = true';
      const customParams: any[] = [];
      let customParamIndex = 1;

      if (search) {
        customWhere += ` AND (name ILIKE $${customParamIndex} OR COALESCE(display_name, '') ILIKE $${customParamIndex})`;
        customParams.push(`%${search}%`);
        customParamIndex++;
      }
      if (theme) {
        customWhere += ` AND theme = $${customParamIndex++}`;
        customParams.push(theme);
      }
      if (rarity) {
        customWhere += ` AND rarity = $${customParamIndex++}`;
        customParams.push(rarity);
      }
      if (colors) {
        const colorList = (colors as string).split(',').filter(c => c.trim());
        if (colorList.length > 0) {
          customWhere += ` AND colors ?| $${customParamIndex++}::text[]`;
          customParams.push(colorList);
        }
      }

      const customCountResult = await pool.query(
        `SELECT COUNT(*) FROM custom_cards ${customWhere}`,
        customParams
      );
      customTotal = parseInt(customCountResult.rows[0].count, 10);
    }

    const combinedTotal = total + customTotal;

    // Get standard cards
    const cardsQuery = `
      SELECT 
        id, scryfall_id, name, set_code, set_name, collector_number,
        rarity, mana_cost, type_line, oracle_text, colors, color_identity,
        image_url, local_image_path, game, prices,
        false as is_custom
      FROM cards
      ${whereClause}
      ORDER BY ${sortField} ${sortDir}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    
    const cardsResult = await pool.query(cardsQuery, [...params, limitNum, offset]);
    let cards = cardsResult.rows;

    // If we have room and including custom cards, add them
    if (showCustom && cards.length < limitNum) {
      const remainingSlots = limitNum - cards.length;
      const customOffset = Math.max(0, offset - total);

      let customWhere = 'WHERE is_active = true';
      const customParams: any[] = [];
      let customParamIndex = 1;

      if (search) {
        customWhere += ` AND (name ILIKE $${customParamIndex} OR COALESCE(display_name, '') ILIKE $${customParamIndex})`;
        customParams.push(`%${search}%`);
        customParamIndex++;
      }
      if (theme) {
        customWhere += ` AND theme = $${customParamIndex++}`;
        customParams.push(theme);
      }
      if (rarity) {
        customWhere += ` AND rarity = $${customParamIndex++}`;
        customParams.push(rarity);
      }
      if (colors) {
        const colorList = (colors as string).split(',').filter(c => c.trim());
        if (colorList.length > 0) {
          customWhere += ` AND colors ?| $${customParamIndex++}::text[]`;
          customParams.push(colorList);
        }
      }

      const customQuery = `
        SELECT 
          id, name, display_name, theme, description, image_path as local_image_path,
          set_code, set_name, type_line, rarity, colors, price,
          true as is_custom, is_featured
        FROM custom_cards
        ${customWhere}
        ORDER BY sort_order ASC, name ASC
        LIMIT $${customParamIndex++} OFFSET $${customParamIndex++}
      `;

      const customResult = await pool.query(customQuery, [...customParams, remainingSlots, customOffset]);
      
      // Transform custom cards to match standard card structure
      const customCards = customResult.rows.map(row => ({
        ...row,
        scryfall_id: null,
        collector_number: null,
        mana_cost: null,
        oracle_text: null,
        color_identity: null,
        image_url: null,
        game: 'magic',
        prices: null,
      }));

      cards = [...cards, ...customCards];
    }

    res.json({
      cards,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: combinedTotal,
        totalPages: Math.ceil(combinedTotal / limitNum),
      },
    });
  } catch (error) {
    console.error('Error fetching cards:', error);
    res.status(500).json({ error: 'Failed to fetch cards' });
  }
});

// GET /api/cards/sets - Get all available sets
router.get('/sets', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT set_code, set_name, COUNT(*) as card_count
      FROM cards
      WHERE is_active = true
      GROUP BY set_code, set_name
      ORDER BY set_name ASC
    `);

    res.json({ sets: result.rows });
  } catch (error) {
    console.error('Error fetching sets:', error);
    res.status(500).json({ error: 'Failed to fetch sets' });
  }
});

// GET /api/cards/search - Quick search for autocomplete (includes custom cards)
router.get('/search', async (req: Request, res: Response) => {
  try {
    const { q, limit = '10', includeCustom = 'true' } = req.query;

    if (!q || (q as string).length < 2) {
      return res.json({ cards: [] });
    }

    const limitNum = Math.min(50, Math.max(1, parseInt(limit as string, 10)));
    const showCustom = includeCustom === 'true';

    // Search standard cards
    const standardResult = await pool.query(`
      SELECT id, name, set_code, set_name, local_image_path, mana_cost, type_line, false as is_custom
      FROM cards
      WHERE is_active = true AND name ILIKE $1
      ORDER BY 
        CASE WHEN name ILIKE $2 THEN 0 ELSE 1 END,
        name ASC
      LIMIT $3
    `, [`%${q}%`, `${q}%`, limitNum]);

    let cards = standardResult.rows;

    // Also search custom cards
    if (showCustom && cards.length < limitNum) {
      const remainingSlots = limitNum - cards.length;
      
      const customResult = await pool.query(`
        SELECT 
          id, name, display_name, theme, set_code, set_name, 
          image_path as local_image_path, type_line, price,
          true as is_custom
        FROM custom_cards
        WHERE is_active = true AND (name ILIKE $1 OR display_name ILIKE $1)
        ORDER BY 
          CASE WHEN name ILIKE $2 THEN 0 ELSE 1 END,
          name ASC
        LIMIT $3
      `, [`%${q}%`, `${q}%`, remainingSlots]);

      // Transform custom cards
      const customCards = customResult.rows.map(row => ({
        ...row,
        mana_cost: null,
      }));

      cards = [...cards, ...customCards];
    }

    res.json({ cards });
  } catch (error) {
    console.error('Error searching cards:', error);
    res.status(500).json({ error: 'Failed to search cards' });
  }
});

// GET /api/cards/:id - Get single card (checks both standard and custom cards)
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // First try standard cards
    const result = await pool.query(`
      SELECT *, false as is_custom FROM cards WHERE id = $1 AND is_active = true
    `, [id]);

    if (result.rows.length > 0) {
      return res.json({ card: result.rows[0] });
    }

    // Try custom cards
    const customResult = await pool.query(`
      SELECT 
        id, name, display_name, theme, description, image_path as local_image_path,
        set_code, set_name, type_line, rarity, colors, price,
        true as is_custom, is_featured,
        NULL as scryfall_id, NULL as collector_number, NULL as mana_cost,
        NULL as oracle_text, NULL as color_identity, NULL as image_url,
        'magic' as game, NULL as prices
      FROM custom_cards 
      WHERE id = $1 AND is_active = true
    `, [id]);

    if (customResult.rows.length === 0) {
      return res.status(404).json({ error: 'Card not found' });
    }

    res.json({ card: customResult.rows[0] });
  } catch (error) {
    console.error('Error fetching card:', error);
    res.status(500).json({ error: 'Failed to fetch card' });
  }
});

export default router;

