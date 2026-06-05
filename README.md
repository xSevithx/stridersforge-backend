# Striders Forge Backend

Express.js API server for the Striders Forge card shop.

## Environment Variables

Create a `.env` file in the `backend/` directory with the following:

```env
# Database
DATABASE_URL=postgres://striderforge:yourpassword@db:5432/striderforge
POSTGRES_USER=striderforge
POSTGRES_PASSWORD=yourpassword
POSTGRES_DB=striderforge

# Authentication
JWT_SECRET=your-secure-jwt-secret

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Frontend URL (for CORS)
FRONTEND_URL=https://yourdomain.com
```

---

## Docker (Production)

### Initial Setup

```bash
# Build the containers
docker-compose build

# Start the services (API + PostgreSQL)
docker-compose up -d

# Run database migrations
docker-compose exec striderforge-api npm run db:migrate

# (Optional) Seed initial data
docker-compose exec striderforge-api npm run db:seed

# (Optional) Sync cards from Scryfall
docker-compose exec striderforge-api npm run sync:scryfall
```

### Updating / Redeploying

```bash
# Pull latest code, then rebuild and restart
docker-compose down
docker-compose build
docker-compose up -d

# Run migrations if schema changed
docker-compose exec striderforge-api npm run db:migrate
```

### Restart Services

```bash
# Restart all services
docker-compose restart

# Restart only the API
docker-compose restart api
```

### View Logs

```bash
# All services
docker-compose logs -f

# API only
docker-compose logs -f api
```

### Stop Services

```bash
docker-compose down
```

---

## Local Development (without Docker)

Requires Node.js 18+ and a PostgreSQL database.

```bash
# Install dependencies
npm install

# Run in development mode (hot reload)
npm run dev

# Run database migrations
npm run db:migrate:dev

# Seed database
npm run db:seed:dev

# Sync cards from Scryfall
npm run sync:scryfall:dev
```

### Build for Production

```bash
npm run build
npm start
```

---

## API Endpoints

The server runs on port `3001` by default.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/cards` | List cards |
| GET | `/api/cards/search` | Search cards |
| GET | `/api/bundles` | List bundles |
| POST | `/api/checkout/create-session` | Create Stripe checkout |
| POST | `/api/checkout/webhook` | Stripe webhook |
| GET | `/api/orders/track/:code` | Track order by code |
| POST | `/api/admin/login` | Admin login |
| GET | `/api/admin/orders` | List orders (admin) |




docker-compose exec api npm run db:migrate
Or you can use docker exec directly with the container name:
docker exec striderforge-api npm run db:migrate
do i need to run this everytime i rebuild the container?

No, you don't need to run migrations every rebuild.
Migrations only need to be run when:
First deployment — to create all tables
After schema changes — when new tables/columns are added (like the bundles table you're missing)
The database data lives in the postgres-data volume, which persists across container rebuilds. Once a migration has run, the tables exist and stay there.
Pro tip: You could add migrations to run automatically on container startup by modifying the Dockerfile or adding a startup script. But for most cases, running manually after schema updates is fine and gives you more control.

docker exec striderforge-api npm run db:migrate