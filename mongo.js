import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;

if (!uri) {
  throw new Error('Missing MONGODB_URI');
}

export const client = new MongoClient(uri);

export const dbPromise = (async () => {
  await client.connect();
  console.log('Connected to MongoDB Atlas');
  return client.db(dbName);
})();
