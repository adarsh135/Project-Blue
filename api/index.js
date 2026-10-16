// Vercel Node.js Function entry point. Export the Express app without starting
// a private listener. Database setup must finish before
// Vercel starts dispatching requests to this instance.
import app from '../server/app.js';
import { ready } from '../server/db.js';

await ready;

export default app;
