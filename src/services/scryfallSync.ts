import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import sharp from 'sharp';
import { pool } from '../db/index.js';
import config from '../config/index.js';

const SCRYFALL_BULK_DATA_URL = 'https://api.scryfall.com/bulk-data';
const IMAGE_CONCURRENCY = 5;
const BATCH_SIZE = 500;

interface ScryfallCard {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
  image_uris?: {
    normal?: string;
    large?: string;
    png?: string;
    art_crop?: string;
    border_crop?: string;
  };
  card_faces?: Array<{
    image_uris?: {
      normal?: string;
      large?: string;
    };
  }>;
  prices?: {
    usd?: string | null;
    usd_foil?: string | null;
    eur?: string | null;
  };
  digital?: boolean;
  layout?: string;
  lang?: string;
}

export interface SyncProgress {
  status: 'idle' | 'downloading' | 'processing' | 'completed' | 'error';
  message: string;
  processed: number;
  total: number;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

// Track current sync state
let currentSync: SyncProgress = {
  status: 'idle',
  message: 'No sync in progress',
  processed: 0,
  total: 0,
};

export const getSyncStatus = (): SyncProgress => ({ ...currentSync });

const ensureDirectories = async () => {
  await fs.mkdir(config.cardImagesDir, { recursive: true });
};

const downloadBulkData = async (): Promise<ScryfallCard[]> => {
  currentSync.message = 'Fetching Scryfall bulk data info...';
  
  const response = await axios.get(SCRYFALL_BULK_DATA_URL);
  const bulkData = response.data.data;
  
  const defaultCards = bulkData.find((d: any) => d.type === 'default_cards');
  
  if (!defaultCards) {
    throw new Error('Could not find default_cards bulk data');
  }
  
  currentSync.message = `Downloading cards (${(defaultCards.size / 1024 / 1024).toFixed(0)} MB)...`;
  
  const cardsResponse = await axios.get(defaultCards.download_uri, {
    responseType: 'json',
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  
  return cardsResponse.data;
};

const filterCards = (cards: ScryfallCard[]): ScryfallCard[] => {
  return cards.filter(card => {
    if (card.lang !== 'en') return false;
    if (card.digital) return false;
    
    const hasImages = card.image_uris?.normal || 
      (card.card_faces && card.card_faces[0]?.image_uris?.normal);
    if (!hasImages) return false;
    
    return true;
  });
};

const getCardImageUrl = (card: ScryfallCard): string | null => {
  if (card.image_uris?.large) return card.image_uris.large;
  if (card.image_uris?.normal) return card.image_uris.normal;
  
  if (card.card_faces && card.card_faces[0]?.image_uris) {
    return card.card_faces[0].image_uris.large || card.card_faces[0].image_uris.normal || null;
  }
  
  return null;
};

const downloadImage = async (
  imageUrl: string,
  scryfallId: string,
  setCode: string
): Promise<string | null> => {
  const setDir = path.join(config.cardImagesDir, setCode);
  await fs.mkdir(setDir, { recursive: true });
  
  const filename = `${scryfallId}.jpg`;
  const localPath = path.join(setDir, filename);
  const relativePath = path.join('card-images', setCode, filename);
  
  try {
    await fs.access(localPath);
    return relativePath;
  } catch {
    // File doesn't exist, download it
  }
  
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    
    await sharp(response.data)
      .jpeg({ quality: 85 })
      .toFile(localPath);
    
    return relativePath;
  } catch (error) {
    console.error(`Failed to download image for ${scryfallId}: ${error}`);
    return null;
  }
};

const insertCardsBatch = async (
  client: any,
  cards: Array<{
    scryfallId: string;
    name: string;
    setCode: string;
    setName: string;
    collectorNumber: string;
    rarity: string;
    manaCost: string | null;
    typeLine: string | null;
    oracleText: string | null;
    colors: string[];
    colorIdentity: string[];
    imageUrl: string | null;
    localImagePath: string | null;
    prices: Record<string, string | null>;
  }>
) => {
  if (cards.length === 0) return;
  
  const values: any[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;
  
  for (const card of cards) {
    placeholders.push(`(
      $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
      $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
      $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
      $${paramIndex++}, $${paramIndex++}, 'magic'
    )`);
    
    values.push(
      card.scryfallId,
      card.name,
      card.setCode,
      card.setName,
      card.collectorNumber,
      card.rarity,
      card.manaCost,
      card.typeLine,
      card.oracleText,
      JSON.stringify(card.colors),
      JSON.stringify(card.colorIdentity),
      card.imageUrl,
      card.localImagePath,
      JSON.stringify(card.prices)
    );
  }
  
  const query = `
    INSERT INTO cards (
      scryfall_id, name, set_code, set_name, collector_number,
      rarity, mana_cost, type_line, oracle_text, colors,
      color_identity, image_url, local_image_path, prices, game
    ) VALUES ${placeholders.join(', ')}
    ON CONFLICT (scryfall_id) DO UPDATE SET
      name = EXCLUDED.name,
      set_code = EXCLUDED.set_code,
      set_name = EXCLUDED.set_name,
      collector_number = EXCLUDED.collector_number,
      rarity = EXCLUDED.rarity,
      mana_cost = EXCLUDED.mana_cost,
      type_line = EXCLUDED.type_line,
      oracle_text = EXCLUDED.oracle_text,
      colors = EXCLUDED.colors,
      color_identity = EXCLUDED.color_identity,
      image_url = EXCLUDED.image_url,
      local_image_path = COALESCE(EXCLUDED.local_image_path, cards.local_image_path),
      prices = EXCLUDED.prices,
      updated_at = NOW();
  `;
  
  await client.query(query, values);
};

export const syncScryfall = async (downloadImages = true): Promise<SyncProgress> => {
  // Don't allow concurrent syncs
  if (currentSync.status === 'downloading' || currentSync.status === 'processing') {
    return currentSync;
  }
  
  currentSync = {
    status: 'downloading',
    message: 'Starting sync...',
    processed: 0,
    total: 0,
    startedAt: new Date(),
  };
  
  try {
    await ensureDirectories();
    
    // Download bulk data
    let allCards = await downloadBulkData();
    console.log(`📊 Total cards from Scryfall: ${allCards.length}`);
    
    // Filter cards
    let cards = filterCards(allCards);
    console.log(`📊 Cards after filtering: ${cards.length}`);
    
    currentSync.status = 'processing';
    currentSync.total = cards.length;
    currentSync.message = `Processing ${cards.length} cards...`;
    
    const client = await pool.connect();
    const imageLimit = pLimit(IMAGE_CONCURRENCY);
    
    try {
      let processed = 0;
      let batch: any[] = [];
      
      for (const card of cards) {
        const imageUrl = getCardImageUrl(card);
        let localImagePath: string | null = null;
        
        if (downloadImages && imageUrl) {
          localImagePath = await imageLimit(() => 
            downloadImage(imageUrl, card.id, card.set)
          );
        }
        
        batch.push({
          scryfallId: card.id,
          name: card.name,
          setCode: card.set,
          setName: card.set_name,
          collectorNumber: card.collector_number,
          rarity: card.rarity,
          manaCost: card.mana_cost || null,
          typeLine: card.type_line || null,
          oracleText: card.oracle_text || null,
          colors: card.colors || [],
          colorIdentity: card.color_identity || [],
          imageUrl,
          localImagePath,
          prices: card.prices || {},
        });
        
        if (batch.length >= BATCH_SIZE) {
          await insertCardsBatch(client, batch);
          processed += batch.length;
          currentSync.processed = processed;
          currentSync.message = `Processing ${processed}/${cards.length} cards (${((processed / cards.length) * 100).toFixed(1)}%)`;
          console.log(currentSync.message);
          batch = [];
        }
      }
      
      // Insert remaining cards
      if (batch.length > 0) {
        await insertCardsBatch(client, batch);
        processed += batch.length;
        currentSync.processed = processed;
      }
      
      currentSync.status = 'completed';
      currentSync.message = `Sync completed! ${processed} cards synced.`;
      currentSync.completedAt = new Date();
      console.log('✅ Scryfall sync completed successfully!');
      
      return currentSync;
    } finally {
      client.release();
      // Note: We do NOT close the pool here so the server keeps running
    }
  } catch (error: any) {
    console.error('❌ Sync failed:', error);
    currentSync.status = 'error';
    currentSync.message = 'Sync failed';
    currentSync.error = error.message;
    throw error;
  }
};
