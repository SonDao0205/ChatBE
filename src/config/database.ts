import { DataSource } from 'typeorm';
import dotenv from 'dotenv';

dotenv.config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'omnichannel_pos',
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
  entities: [__dirname + '/../entity/**/*.{ts,js}'],
  migrations: [__dirname + '/../migrations/**/*.{ts,js}'],
});
