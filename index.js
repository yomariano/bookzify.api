import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

// ES Module dirname setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Temporary diagnostic: Log available environment variables
console.log('🔍 Environment variable diagnostics:');
console.log(`📡 NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
console.log(`🔗 SUPABASE_URL: ${process.env.SUPABASE_URL ? 'set' : 'not set'}`);
console.log(`🔑 SERVICE_SUPABASEANON_KEY: ${process.env.SERVICE_SUPABASEANON_KEY ? 'set' : 'not set'}`);
console.log(`🔑 SUPABASE_ANON_KEY: ${process.env.SUPABASE_ANON_KEY ? 'set' : 'not set'}`);
console.log(`🔑 SERVICE_SUPABASESERVICE_KEY: ${process.env.SERVICE_SUPABASESERVICE_KEY ? 'set' : 'not set'}`);
console.log(`🔒 POSTGRES_PASSWORD: ${process.env.POSTGRES_PASSWORD ? 'set' : 'not set'}`);

// Look for any environment variables that might contain Supabase URLs
const allEnvVars = Object.keys(process.env).filter(key => 
  key.toLowerCase().includes('supabase') || 
  key.toLowerCase().includes('url') ||
  key.toLowerCase().includes('host')
);
console.log('🌐 Supabase/URL-related environment variables found:', allEnvVars);

if (process.env.SUPABASE_URL) {
  console.log(`📍 SUPABASE_URL value: ${process.env.SUPABASE_URL}`);
} else {
  console.log('❌ SUPABASE_URL is not set');
  // Look for alternative URL variables
  const urlVars = allEnvVars.filter(key => key.includes('URL') || key.includes('url'));
  if (urlVars.length > 0) {
    console.log('🔍 Found other URL variables:', urlVars.map(key => `${key}=${process.env[key] ? 'set' : 'not set'}`));
  }
}

// Enhanced Supabase connection validation
async function validateSupabaseConnection(supabaseClient, connectionString) {
  try {
    console.log('🔧 Validating Supabase connection...');
    console.log(`📍 Connection URL: ${connectionString.replace(/password=[^&]*/g, 'password=***')}`);
    
    // Test the connection with a simple query
    const { data, error } = await supabaseClient
      .from('books')
      .select('count')
      .limit(1)
      .single();
    
    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found" which is acceptable
      console.error('❌ Supabase connection validation failed:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code
      });
      throw new Error(`Supabase connection failed: ${error.message} (Code: ${error.code})`);
    }
    
    console.log('✅ Supabase connection validated successfully');
    return true;
  } catch (error) {
    console.error('❌ Supabase connection validation error:', {
      name: error.name,
      message: error.message,
      cause: error.cause,
      stack: error.stack?.split('\n').slice(0, 3).join('\n')
    });
    throw error;
  }
}

// Initialize Supabase client with environment-specific URL
let supabaseUrl;
if (process.env.NODE_ENV === 'production') {
  // For production, we still need to use the Supabase HTTP URL, not a PostgreSQL connection string
  // The Supabase JavaScript client connects to the REST API, not directly to PostgreSQL
  supabaseUrl = process.env.SUPABASE_URL;
  
  if (!supabaseUrl) {
    console.error('❌ SUPABASE_URL is required for production environment');
    console.error('💡 The Supabase JavaScript client requires an HTTP/HTTPS URL like: https://your-project.supabase.co');
    console.error('💡 It cannot use PostgreSQL connection strings directly.');
    process.exit(1);
  }
  
  console.log('🔧 Using Supabase REST API URL for production');
  
  // PRODUCTION NETWORK FALLBACK: Try internal Docker networking if external fails
  if (process.env.COOLIFY_URL) {
    console.log('🐳 Detected Coolify/Docker environment - will implement internal networking fallback if external fails');
  }
  
} else {
  // For development, use the standard Supabase URL
  supabaseUrl = process.env.SUPABASE_URL;
  console.log('🔧 Using standard Supabase URL for development');
}

const supabaseKey = process.env.SERVICE_SUPABASEANON_KEY || process.env.SUPABASE_ANON_KEY;

// Debug: Compare with frontend key.
const frontendKey = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc0NzUxODI0MCwiZXhwIjo0OTAzMTkxODQwLCJyb2xlIjoic2VydmljZV9yb2xlIn0.-Q1GLX4t6XshgYFIeYfCx5bgNsYVAhu-2CP5VC_RpjM";

console.log('🔑 API Key Comparison:');
console.log(`🔧 Backend using: ${process.env.SERVICE_SUPABASEANON_KEY ? 'SERVICE_SUPABASEANON_KEY' : 'SUPABASE_ANON_KEY'}`);
console.log(`🔧 Backend key: ${supabaseKey ? supabaseKey.substring(0, 50) + '...' : 'MISSING'}`);
console.log(`🖥️ Frontend key: ${frontendKey.substring(0, 50)}...`);
console.log(`🔍 Keys match: ${supabaseKey === frontendKey ? '✅ YES' : '❌ NO'}`);

// Enhanced environment variable validation
const requiredEnvVars = {
  'SUPABASE_URL': supabaseUrl,
  'SERVICE_SUPABASEANON_KEY or SUPABASE_ANON_KEY': supabaseKey,
  'VITE_OPENROUTER_API_KEY': process.env.VITE_OPENROUTER_API_KEY,
  'VITE_HUGGINGFACE_API_KEY': process.env.VITE_HUGGINGFACE_API_KEY
};

// Optional validation for PostgreSQL credentials (for direct DB access if needed later)
if (process.env.NODE_ENV === 'production' && process.env.POSTGRES_PASSWORD) {
  console.log('📝 PostgreSQL credentials available for direct database access if needed');
  console.log(`🔗 PostgreSQL connection: postgresql://postgres:***@supabase-db:5432/postgres`);
}

const missingEnvVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
  process.exit(1);
}

// Enhanced Supabase client initialization with better error handling
let supabase;
try {
  console.log('🔧 Initializing Supabase client...');
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Supabase URL: ${supabaseUrl.replace(/password=[^&]*/g, 'password=***')}`);
  console.log(`🔑 Using ${supabaseKey ? 'valid' : 'missing'} API key`);
  
  // TEMPORARY: Use same configuration as working frontend
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false
    }
    // Removed custom fetch wrapper temporarily to match frontend
  });
  
  console.log('✅ Supabase client created successfully (simplified config)');
  
  // PRODUCTION FALLBACK: Test connectivity and implement workaround if needed
  if (process.env.NODE_ENV === 'production') {
    console.log('🔧 Production environment detected - testing connectivity...');
    
    // IMMEDIATE PostgreSQL FALLBACK: Try direct connection first to bypass network issues
    if (process.env.POSTGRES_PASSWORD) {
      console.log('💾 PostgreSQL credentials detected - attempting direct connection as primary method...');
      
      try {
        const postgres = await import('postgres');
        const pgClient = postgres.default({
          host: 'supabase-db', 
          port: 5432,
          database: 'postgres',
          username: 'postgres',
          password: process.env.POSTGRES_PASSWORD,
          connect_timeout: 5,
          max: 10
        });
        
        // Test the connection immediately
        const testResult = await pgClient`SELECT 1 as test`;
        if (testResult && testResult.length > 0) {
          console.log('✅ Direct PostgreSQL connection successful! Using as primary database.');
          
          // Replace the Supabase client with a simplified PostgreSQL-based one
          supabase = {
            from: (table) => ({
              select: (columns = '*') => ({
                eq: (column, value) => ({
                  single: async () => {
                    try {
                      // Use template literals for table and column names (unsafe but needed for dynamic queries)
                      const query = `SELECT ${columns} FROM ${table} WHERE ${column} = $1 LIMIT 1`;
                      const result = await pgClient.unsafe(query, [value]);
                      return { data: result[0] || null, error: null };
                    } catch (error) {
                      return { data: null, error: { message: error.message, code: 'PG_ERROR' } };
                    }
                  }
                }),
                limit: (limit) => ({
                  single: async () => {
                    try {
                      const query = `SELECT ${columns} FROM ${table} LIMIT ${limit}`;
                      const result = await pgClient.unsafe(query);
                      return { data: result[0] || null, error: null };
                    } catch (error) {
                      return { data: null, error: { message: error.message, code: 'PG_ERROR' } };
                    }
                  }
                }),
                single: async () => {
                  try {
                    const query = `SELECT ${columns} FROM ${table} LIMIT 1`;
                    const result = await pgClient.unsafe(query);
                    return { data: result[0] || null, error: null };
                  } catch (error) {
                    return { data: null, error: { message: error.message, code: 'PG_ERROR' } };
                  }
                }
              }),
              insert: (records) => ({
                select: () => ({
                  single: async () => {
                    try {
                      const record = records[0];
                      const keys = Object.keys(record);
                      const values = Object.values(record);
                      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
                      const query = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
                      const result = await pgClient.unsafe(query, values);
                      return { data: result[0], error: null };
                    } catch (error) {
                      return { data: null, error: { message: error.message, code: 'PG_ERROR' } };
                    }
                  }
                })
              }),
              delete: () => ({
                eq: (column, value) => ({
                  async then(resolve) {
                    try {
                      const query = `DELETE FROM ${table} WHERE ${column} = $1`;
                      await pgClient.unsafe(query, [value]);
                      resolve({ error: null });
                    } catch (error) {
                      resolve({ error: { message: error.message, code: 'PG_ERROR' } });
                    }
                  }
                })
              })
            }),
            storage: {
              from: () => ({
                upload: () => ({ data: null, error: { message: 'Storage not available in PostgreSQL mode - network isolated' } }),
                remove: () => ({ error: { message: 'Storage not available in PostgreSQL mode' } }),
                getPublicUrl: () => ({ data: { publicUrl: '' } }),
                createSignedUrl: () => ({ data: null, error: { message: 'Storage not available in PostgreSQL mode' } })
              })
            }
          };
          
          console.log('🔄 Supabase client replaced with PostgreSQL direct connection.');
          console.log('⚠️ Note: Storage operations disabled due to network isolation, but database queries will function.');
          
          // Skip the network test since we're using direct PostgreSQL - use flag instead of return
          console.log('✅ PostgreSQL mode active - skipping network-based tests');
        }
      } catch (pgError) {
        console.error('❌ Direct PostgreSQL connection failed:', pgError);
        console.log('🔄 Falling back to network-based Supabase connection...');
      }
    }
    
    // Original network-based fallback (only if PostgreSQL failed)
    setTimeout(async () => {
      try {
        console.log('🧪 Testing production Supabase connectivity...');
        const { data, error } = await supabase
          .from('books')
          .select('*', { count: 'exact' })           
          .limit(1)
          .single();
        
        if (error && error.code !== 'PGRST116') {
          console.error('❌ Production Supabase connectivity failed:', error);
          console.log('🔄 Implementing production networking workaround...');
          
          // Create fallback client with internal networking
          const fallbackClient = createClient(supabaseUrl, supabaseKey, {
            auth: { persistSession: false }
            // Removed complex fallback fetch wrapper - using simpler approach
          });
          
          // Test if the simplified client works better
          console.log('🧪 Testing simplified fallback client...');
          const { data: testData, error: testError } = await fallbackClient
            .from('books')
            .select('id', { count: 'exact', head: true })
            .limit(1);
          
          if (!testError || testError.code === 'PGRST116') {
            console.log('✅ Simplified fallback client works! Replacing global client...');
            supabase = fallbackClient;
          } else {
            console.log('❌ Simplified fallback also failed, keeping original client');
          }
          
        } else {
          console.log('✅ Production Supabase connectivity working normally');
        }
      } catch (testError) {
        console.error('❌ Production connectivity test failed:', testError);
        console.log('ℹ️ Continuing with standard client - some features may be limited');
        
        // ULTIMATE FALLBACK: Direct PostgreSQL connection if available
        if (process.env.POSTGRES_PASSWORD) {
          console.log('🔄 Network connectivity failed. Attempting direct PostgreSQL connection...');
          console.log('📋 PostgreSQL credentials detected - implementing direct DB fallback');
          console.log('🔗 PostgreSQL available at: postgresql://postgres:***@supabase-db:5432/postgres');
          
          try {
            // Try to create a direct PostgreSQL connection using pg library
            const { createClient } = await import('postgres');
            
            const pgClient = createClient({
              host: 'supabase-db',
              port: 5432,
              database: 'postgres',
              username: 'postgres',
              password: process.env.POSTGRES_PASSWORD
            });
            
            // Test the PostgreSQL connection
            const testResult = await pgClient`SELECT 1 as test`;
            if (testResult && testResult.length > 0) {
              console.log('✅ Direct PostgreSQL connection successful!');
              console.log('🔄 Creating custom Supabase-compatible client...');
              
              // Create a custom client that routes through PostgreSQL
              supabase = createCustomSupabaseClient(pgClient, supabaseKey);
            }
          } catch (pgError) {
            console.error('❌ Direct PostgreSQL connection also failed:', pgError);
            console.log('🚨 All database connection methods exhausted');
          }
        }
      }
    }, 2000); // Test after 2 seconds
  }
  
  // Skip validation during initialization, we'll do it manually
  console.log('⚠️ Skipping automatic validation - will test connectivity manually');
  
} catch (error) {
  console.error('❌ Failed to initialize Supabase client:', {
    name: error.name,
    message: error.message,
    cause: error.cause,
    stack: error.stack?.split('\n').slice(0, 5).join('\n')
  });
  process.exit(1);
}

// Manual connectivity test with more detailed diagnostics
console.log('🧪 Running manual connectivity test...');
setTimeout(async () => {
  try {
    console.log('🔍 Testing basic HTTP connectivity to Supabase URL...');
    
    // Test 1: Basic domain resolution and HTTP connectivity
    const testUrl = new URL(supabaseUrl);
    const baseUrl = `${testUrl.protocol}//${testUrl.host}`;
    
    console.log(`🌐 Testing base URL: ${baseUrl}`);
    const response = await fetch(baseUrl, {
      method: 'HEAD',
      timeout: 10000
    });
    
    console.log(`✅ Base URL accessible: ${response.status} ${response.statusText}`);
    
    // Test 2: Supabase REST API endpoint
    const restUrl = `${supabaseUrl}/rest/v1/`;
    console.log(`🔗 Testing REST API: ${restUrl}`);
    
    const restResponse = await fetch(restUrl, {
      method: 'GET',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      timeout: 10000
    });
    
    console.log(`✅ REST API accessible: ${restResponse.status} ${restResponse.statusText}`);
    
    // Test 3: Try a simple query
    console.log(`💾 Testing database query...`);
    const { data, error } = await supabase
      .from('books')
      .select('id', { count: 'exact', head: true })
      .limit(1);
    
    if (error && error.code !== 'PGRST116') {
      console.error('❌ Database query failed:', error);
    } else {
      console.log('✅ Database query successful');
    }
    
    console.log('🚀 All connectivity tests completed - starting server...');
    
  } catch (testError) {
    console.error('❌ Connectivity test failed:', {
      name: testError.name,
      message: testError.message,
      code: testError.code,
      errno: testError.errno,
      syscall: testError.syscall,
      hostname: testError.hostname,
      cause: testError.cause
    });
    
    console.log('⚠️ Starting server anyway - connectivity issues may affect functionality');
  }
}, 1000);

// Support multiple book sources
const BOOK_SOURCES = {
  'ebook-hunter': 'https://ebook-hunter.org',
  'annas-archive': 'https://annas-archive.org'
};

// Default source (keeping existing behavior)
const DEFAULT_SOURCE = 'ebook-hunter';

// Helper function to get base URL for a source
function getBaseUrl(source = DEFAULT_SOURCE) {
  return BOOK_SOURCES[source] || BOOK_SOURCES[DEFAULT_SOURCE];
}

// Helper function to upload file to Supabase storage
async function uploadToSupabaseStorage(filePath, fileName, bookMetadata) {
  try {
    console.log('📤 Uploading file to Supabase storage...');
    
    // Read the file
    const fileBuffer = await fs.promises.readFile(filePath);
    
    // Sanitize filename to remove special characters that cause Supabase issues
    const sanitizeFilename = (filename) => {
      return filename
        .replace(/[^\w\s.-]/g, '') // Remove special chars except word chars, spaces, dots, hyphens
        .replace(/\s+/g, '_')      // Replace spaces with underscores
        .replace(/_{2,}/g, '_')    // Replace multiple underscores with single
        .replace(/^_+|_+$/g, '')   // Remove leading/trailing underscores
        .substring(0, 100);        // Limit length to 100 chars
    };
    
    const sanitizedFileName = sanitizeFilename(fileName);
    console.log(`📝 Original filename: ${fileName}`);
    console.log(`🧹 Sanitized filename: ${sanitizedFileName}`);
    
    // Generate a unique filename to avoid conflicts
    const uniqueFileName = `${crypto.randomUUID()}_${sanitizedFileName}`;
    
    // Determine content type based on file extension
    const getContentType = (filename) => {
      const ext = path.extname(filename).toLowerCase();
      switch (ext) {
        case '.pdf': return 'application/pdf';
        case '.epub': return 'application/epub+zip';
        case '.mobi': return 'application/x-mobipocket-ebook';
        case '.azw': return 'application/vnd.amazon.ebook';
        case '.azw3': return 'application/vnd.amazon.ebook';
        case '.txt': return 'text/plain';
        case '.doc': return 'application/msword';
        case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        default: return 'application/octet-stream';
      }
    };
    
    const contentType = getContentType(sanitizedFileName);
    console.log(`📄 Content type: ${contentType}`);
    
    // Upload to Supabase storage bucket 'books'
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('books')
      .upload(uniqueFileName, fileBuffer, {
        contentType: contentType,
        upsert: false
      });

    if (uploadError) {
      console.error('❌ Supabase storage upload error:', uploadError);
      throw uploadError;
    }

    console.log('✅ File uploaded to storage:', uploadData.path);

    // Get the public URL for the uploaded file
    const { data: urlData } = supabase.storage
      .from('books')
      .getPublicUrl(uploadData.path);

    const s3BucketUrl = urlData.publicUrl;
    console.log('🔗 Public URL generated:', s3BucketUrl);

    // Insert book record into the database
    const bookRecord = {
      id: crypto.randomUUID(),
      title: bookMetadata.title || 'Unknown Title',
      author: bookMetadata.author || 'Unknown Author',
      format: bookMetadata.format || 'pdf',
      date: bookMetadata.date || null,
      category: bookMetadata.category || null,
      book_url: bookMetadata.bookUrl || null,
      cover_image_url: bookMetadata.coverImageUrl || null,
      download_url: bookMetadata.downloadUrl || null,
      description: null,
      language: null,
      published_date: null,
      s3_bucket_id: uploadData.path,
      s3_bucket_url: s3BucketUrl,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    console.log('💾 Inserting book record into database...');
    const { data: insertData, error: insertError } = await supabase
      .from('books')
      .insert([bookRecord])
      .select()
      .single();

    if (insertError) {
      console.error('❌ Database insert error:', insertError);
      // If database insert fails, try to clean up the uploaded file
      try {
        await supabase.storage.from('books').remove([uploadData.path]);
        console.log('🧹 Cleaned up uploaded file after database error');
      } catch (cleanupError) {
        console.error('❌ Failed to cleanup uploaded file:', cleanupError);
      }
      throw insertError;
    }

    console.log('✅ Book record inserted successfully:', insertData.id);
    
    return {
      id: insertData.id,
      s3_bucket_url: s3BucketUrl,
      s3_bucket_id: uploadData.path
    };

  } catch (error) {
    console.error('❌ Error in uploadToSupabaseStorage:', error);
    throw error;
  }
}

// Enhanced helper function to check if book already exists
async function checkBookExists(downloadUrl) {
  try {
    console.log(`🔍 Checking database for book with download_url: ${downloadUrl}`);
    
    // Add connection health check before query
    if (!supabase) {
      throw new Error('Supabase client not initialized');
    }
    
    const { data, error } = await supabase
      .from('books')
      .select('id, title, author, download_url, s3_bucket_url')
      .eq('download_url', downloadUrl)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found" error
      console.error('❌ Database query error:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
        query: 'books table with download_url filter'
      });
      throw error;
    }

    if (data) {
      console.log(`✅ Found existing book in database:`, {
        id: data.id,
        title: data.title,
        author: data.author,
        download_url: data.download_url,
        s3_bucket_url: data.s3_bucket_url
      });
      
      // Validate that the URLs make sense together
      if (data.download_url !== downloadUrl) {
        console.warn(`⚠️ URL mismatch detected! Requested: ${downloadUrl}, Found: ${data.download_url}`);
      }
      
      // Check if s3_bucket_url seems to match the expected content
      const downloadUrlLower = downloadUrl.toLowerCase();
      const s3UrlLower = data.s3_bucket_url.toLowerCase();
      
      // Extract filename from download URL for basic validation
      const downloadUrlParts = downloadUrl.split('/');
      const downloadFilename = downloadUrlParts[downloadUrlParts.length - 1] || '';
      
      if (downloadFilename && !s3UrlLower.includes(downloadFilename.toLowerCase().split('.')[0])) {
        console.warn(`⚠️ Potential data corruption detected!`);
        console.warn(`   Download URL: ${downloadUrl}`);
        console.warn(`   S3 URL: ${data.s3_bucket_url}`);
        console.warn(`   Expected filename: ${downloadFilename}`);
        console.warn(`   This might indicate corrupted database data.`);
      }
    } else {
      console.log(`📭 No existing book found for URL: ${downloadUrl}`);
    }

    return data; // Returns null if not found, or book data if found
  } catch (error) {
    console.error('❌ Enhanced error details for checkBookExists:', {
      name: error.name,
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
      cause: error.cause,
      errno: error.errno,
      syscall: error.syscall,
      hostname: error.hostname,
      stack: error.stack?.split('\n').slice(0, 5).join('\n'),
      downloadUrl,
      supabaseClientExists: !!supabase,
      networkInfo: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      }
    });
    throw error;
  }
}

const app = express();
const PORT = process.env.PORT || 5005;

// Enhanced CORS configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? [
        // Production domains
        'https://bookzify.xyz',
        'https://www.bookzify.xyz',
        'https://api.bookzify.xyz'
      ]
    : [
        // Development origins
        'http://localhost:3000',    // Next.js default
        'http://localhost:3001',    // Alternative React port
        'http://localhost:5173',    // Vite default (your frontend)
        'http://localhost:4000',    // Alternative port
        'http://127.0.0.1:3000',    // Alternative localhost format
        'http://127.0.0.1:3001',
        'http://127.0.0.1:5173',    // Your frontend
        'http://127.0.0.1:4000',
        // Allow any localhost port in development
        /^http:\/\/localhost:\d+$/,
        /^http:\/\/127\.0\.0\.1:\d+$/
      ],
  credentials: true,            // Allow cookies and auth headers
  optionsSuccessStatus: 200,    // For legacy browser support
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Origin',
    'Access-Control-Allow-Origin'
  ],
  exposedHeaders: ['Access-Control-Allow-Origin']
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// CORS debugging middleware
app.use((req, res, next) => {
  const origin = req.get('Origin');
  const host = req.get('Host');
  
  console.log(`🌐 CORS Debug:
    Origin: ${origin || 'not set'}
    Host: ${host || 'not set'}
    Method: ${req.method}
    Path: ${req.path}
    Environment: ${process.env.NODE_ENV}
  `);
  
  if (origin) {
    const isAllowed = corsOptions.origin.includes(origin) || 
      (typeof corsOptions.origin[0] === 'object' && corsOptions.origin.some(pattern => pattern.test(origin)));
    console.log(`🔒 CORS: ${isAllowed ? 'Allowed' : 'Blocked'} request from origin: ${origin}`);
  }
  next();
});

// OpenRouter API proxy
app.post('/api/openrouter/chat', async (req, res) => {
  try {
    const openRouterApiKey = process.env.VITE_OPENROUTER_API_KEY;
    
    if (!openRouterApiKey) {
      return res.status(500).json({ error: 'OpenRouter API key not configured' });
    }

    // Set default model to Google Gemma if not specified
    const requestBody = {
      model: 'google/gemma-2-9b-it:free',
      ...req.body
    };

    // Override model if user specifically requests the 3n-e4b variant
    if (req.body.model === 'google/gemma-3n-e4b-it:free') {
      requestBody.model = 'google/gemma-3n-e4b-it:free';
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5005', // Optional: for analytics
        'X-Title': 'BookHub API' // Optional: for analytics
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.text();
      return res.status(response.status).json({ 
        error: `OpenRouter API error: ${response.status} ${response.statusText}`,
        details: errorData 
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('OpenRouter proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Hugging Face API proxy
app.post('/api/huggingface/inference', async (req, res) => {
  try {
    const huggingfaceApiKey = process.env.VITE_HUGGINGFACE_API_KEY;
    
    if (!huggingfaceApiKey) {
      return res.status(500).json({ error: 'Hugging Face API key not configured' });
    }

    const { model, ...requestBody } = req.body;
    const modelUrl = `https://api-inference.huggingface.co/models/${model}`;

    const response = await fetch(modelUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${huggingfaceApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.text();
      return res.status(response.status).json({ 
        error: `Hugging Face API error: ${response.status} ${response.statusText}`,
        details: errorData 
      });
    }

    // Handle different response types (JSON or binary)
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('audio')) {
      // For audio responses, stream the binary data
      const buffer = await response.arrayBuffer();
      res.set('Content-Type', contentType);
      res.send(Buffer.from(buffer));
    } else {
      // For JSON responses
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error('Hugging Face proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const supabaseConfigured = process.env.NODE_ENV === 'production' 
    ? !!process.env.POSTGRES_PASSWORD 
    : !!process.env.SUPABASE_URL;
  
  // Test database connectivity
  let databaseStatus = 'unknown';
  let databaseError = null;
  
  try {
    if (supabase) {
      console.log('🩺 Health check: Testing database connectivity...');
      const { data, error } = await supabase
        .from('books')
        .select('count')
        .limit(1)
        .single();
      
      if (error && error.code !== 'PGRST116') {
        databaseStatus = 'error';
        databaseError = {
          message: error.message,
          code: error.code,
          details: error.details
        };
        console.error('❌ Health check: Database connectivity failed:', databaseError);
      } else {
        databaseStatus = 'connected';
        console.log('✅ Health check: Database connectivity successful');
      }
    } else {
      databaseStatus = 'not_initialized';
      databaseError = 'Supabase client not initialized';
    }
  } catch (healthError) {
    databaseStatus = 'error';
    databaseError = {
      name: healthError.name,
      message: healthError.message,
      errno: healthError.errno,
      syscall: healthError.syscall,
      hostname: healthError.hostname
    };
    console.error('❌ Health check: Database test failed:', databaseError);
  }
    
  const healthData = { 
    status: databaseStatus === 'connected' ? 'healthy' : 'degraded', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    database: {
      status: databaseStatus,
      error: databaseError,
      url: supabaseUrl ? supabaseUrl.replace(/password=[^&]*/g, 'password=***') : 'not_set'
    },
    services: {
      openrouter: !!process.env.VITE_OPENROUTER_API_KEY,
      huggingface: !!process.env.VITE_HUGGINGFACE_API_KEY,
      supabase: supabaseConfigured
    },
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
      },
      uptime: Math.round(process.uptime()) + ' seconds'
    }
  };
  
  const statusCode = databaseStatus === 'connected' ? 200 : 503;
  res.status(statusCode).json(healthData);
});

// Network diagnostics endpoint
app.get('/admin/network/diagnostics', async (req, res) => {
  try {
    console.log('🔧 Running network diagnostics...');
    
    const diagnostics = {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      tests: {}
    };
    
    // Test 1: DNS Resolution
    try {
      const { promisify } = await import('util');
      const dns = await import('dns');
      const lookup = promisify(dns.lookup);
      
      // Extract hostname from Supabase URL
      const urlObj = new URL(supabaseUrl);
      const hostname = urlObj.hostname;
      
      console.log(`🔍 Testing DNS resolution for: ${hostname}`);
      const dnsResult = await lookup(hostname);
      
      diagnostics.tests.dns = {
        status: 'success',
        hostname,
        resolved_ip: dnsResult.address,
        family: dnsResult.family
      };
      console.log(`✅ DNS resolved: ${hostname} -> ${dnsResult.address}`);
    } catch (dnsError) {
      diagnostics.tests.dns = {
        status: 'failed',
        error: {
          name: dnsError.name,
          message: dnsError.message,
          code: dnsError.code,
          errno: dnsError.errno,
          syscall: dnsError.syscall
        }
      };
      console.error('❌ DNS resolution failed:', dnsError);
    }
    
    // Test 2: Basic HTTP connectivity
    try {
      console.log('🌐 Testing basic HTTP connectivity...');
      const testUrl = new URL(supabaseUrl);
      const baseUrl = `${testUrl.protocol}//${testUrl.host}`;
      
      const response = await fetch(baseUrl, {
        method: 'HEAD',
        timeout: 10000
      });
      
      diagnostics.tests.http = {
        status: 'success',
        url: baseUrl,
        status_code: response.status,
        headers: Object.fromEntries(response.headers.entries())
      };
      console.log(`✅ HTTP connectivity successful: ${response.status}`);
    } catch (httpError) {
      diagnostics.tests.http = {
        status: 'failed',
        error: {
          name: httpError.name,
          message: httpError.message,
          cause: httpError.cause,
          errno: httpError.errno,
          syscall: httpError.syscall,
          hostname: httpError.hostname
        }
      };
      console.error('❌ HTTP connectivity failed:', httpError);
    }
    
    // Test 3: Supabase API endpoint
    try {
      console.log('🔗 Testing Supabase API endpoint...');
      const apiUrl = `${supabaseUrl}/rest/v1/`;
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        },
        timeout: 10000
      });
      
      diagnostics.tests.supabase_api = {
        status: response.ok ? 'success' : 'failed',
        url: apiUrl.replace(/password=[^&]*/g, 'password=***'),
        status_code: response.status,
        status_text: response.statusText
      };
      
      if (response.ok) {
        console.log(`✅ Supabase API accessible: ${response.status}`);
      } else {
        console.error(`❌ Supabase API error: ${response.status} ${response.statusText}`);
      }
    } catch (supabaseError) {
      diagnostics.tests.supabase_api = {
        status: 'failed',
        error: {
          name: supabaseError.name,
          message: supabaseError.message,
          errno: supabaseError.errno,
          syscall: supabaseError.syscall,
          hostname: supabaseError.hostname
        }
      };
      console.error('❌ Supabase API test failed:', supabaseError);
    }
    
    // Test 4: Database query
    try {
      console.log('💾 Testing database query...');
      const { data, error } = await supabase
        .from('books')
        .select('count')
        .limit(1)
        .single();
      
      if (error && error.code !== 'PGRST116') {
        diagnostics.tests.database = {
          status: 'failed',
          error: {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code
          }
        };
        console.error('❌ Database query failed:', error);
      } else {
        diagnostics.tests.database = {
          status: 'success',
          message: 'Database query successful'
        };
        console.log('✅ Database query successful');
      }
    } catch (dbError) {
      diagnostics.tests.database = {
        status: 'failed',
        error: {
          name: dbError.name,
          message: dbError.message,
          errno: dbError.errno,
          syscall: dbError.syscall,
          hostname: dbError.hostname
        }
      };
      console.error('❌ Database query test failed:', dbError);
    }
    
    // Determine overall status
    const testResults = Object.values(diagnostics.tests);
    const failedTests = testResults.filter(test => test.status === 'failed');
    const overallStatus = failedTests.length === 0 ? 'all_passed' : 
                         failedTests.length === testResults.length ? 'all_failed' : 'partial_failure';
    
    diagnostics.summary = {
      overall_status: overallStatus,
      total_tests: testResults.length,
      passed: testResults.length - failedTests.length,
      failed: failedTests.length
    };
    
    console.log(`📊 Network diagnostics completed: ${overallStatus}`);
    
    const statusCode = overallStatus === 'all_passed' ? 200 : 
                      overallStatus === 'partial_failure' ? 207 : 500;
    
    res.status(statusCode).json(diagnostics);
    
  } catch (error) {
    console.error('❌ Error running network diagnostics:', error);
    res.status(500).json({
      error: 'Failed to run network diagnostics',
      details: error.message
    });
  }
});

// Book content proxy endpoint
app.post('/api/proxy/book-content', async (req, res) => {
  try {
    const { url, format } = req.body;
    const startTime = Date.now();
    
    if (!url) {
      return res.status(400).json({ 
        error: 'Missing required field: url' 
      });
    }

    console.log(`[BookProxy] 📥 Fetching ${format || 'unknown'} content from:`, url);
    console.log(`[BookProxy] Using service key:`, process.env.SERVICE_SUPABASESERVICE_KEY ? 'Yes' : 'No');
    console.log(`[BookProxy] Using anon key:`, process.env.SERVICE_SUPABASEANON_KEY ? 'Yes' : 'No');

    // Handle different URL types
    let response;
    
    if (url.includes('supabase')) {
      response = await handleSupabaseUrl(url);
    } else if (url.includes('s3.amazonaws.com') || url.includes('amazonaws.com')) {
      response = await handleS3Url(url);
    } else {
      response = await handleExternalUrl(url);
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[BookProxy] ❌ Error fetching content: ${response.status} ${response.statusText}`);
      console.error(`[BookProxy] Error details:`, errorText);
      return res.status(response.status).json({
        error: `Failed to fetch book content: ${response.status} ${response.statusText}`,
        details: errorText
      });
    }

    // Get content type from response headers
    const contentType = response.headers.get('content-type') || 'unknown';
    console.log(`[BookProxy] 📄 Content-Type from source:`, contentType);

    // Determine response type based on format
    const isTextFormat = format && ['txt', 'html'].includes(format.toLowerCase());
    
    let contentSize = 0;
    let responseData;

    if (isTextFormat) {
      responseData = await response.text();
      contentSize = Buffer.from(responseData).length;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(responseData);
    } else {
      // Binary format (PDF, EPUB, etc.)
      const arrayBuffer = await response.arrayBuffer();
      responseData = Buffer.from(arrayBuffer);
      contentSize = responseData.length;
      
      // Set appropriate content type based on format
      let responseContentType = 'application/octet-stream';
      if (format) {
        switch (format.toLowerCase()) {
          case 'pdf':
            responseContentType = 'application/pdf';
            break;
          case 'epub':
            responseContentType = 'application/epub+zip';
            break;
          case 'mobi':
            responseContentType = 'application/x-mobipocket-ebook';
            break;
          case 'azw':
          case 'azw3':
            responseContentType = 'application/vnd.amazon.ebook';
            break;
        }
      }
      
      res.setHeader('Content-Type', responseContentType);
      res.setHeader('Content-Length', contentSize);
      res.send(responseData);
    }

    // Calculate size in MB and processing time
    const sizeInMB = (contentSize / (1024 * 1024)).toFixed(2);
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`[BookProxy] 📊 Content Stats:
    • Size: ${sizeInMB} MB
    • Type: ${isTextFormat ? 'Text' : 'Binary'} (${format || 'unknown'})
    • Source Type: ${contentType}
    • Processing Time: ${processingTime}s`);

    console.log(`[BookProxy] ✅ Successfully proxied ${format || 'unknown'} content`);

  } catch (error) {
    console.error('[BookProxy] ❌ Error:', error);
    res.status(500).json({
      error: 'Internal server error while fetching book content',
      details: error.message
    });
  }
});

// Helper functions for handling different URL types
async function handleSupabaseUrl(url) {
  console.log('[BookProxy] Handling Supabase URL');
  
  try {
    // Parse the Supabase URL to extract the base URL and file path
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    
    // Find the bucket name and file path
    // Path structure: /storage/v1/object/public/{bucket}/{file_path}
    const bucketIndex = pathParts.findIndex(part => part === 'public' || part === 'sign');
    if (bucketIndex === -1 || bucketIndex + 2 >= pathParts.length) {
      throw new Error('Invalid Supabase storage URL format');
    }
    
    const bucketName = pathParts[bucketIndex + 1]; // 'books'
    const filePath = pathParts.slice(bucketIndex + 2).join('/'); // the actual file path
    
    console.log(`[BookProxy] URL parts:`, {
      protocol: urlObj.protocol,
      host: urlObj.host,
      pathname: urlObj.pathname,
      pathParts,
      bucketIndex,
      bucketName,
      filePath
    });
    
    // Method 1: Use direct storage API endpoint (this is what works)
    try {
      const storageApiUrl = `${urlObj.protocol}//${urlObj.host}/storage/v1/object/${bucketName}/${filePath}`;
      console.log(`[BookProxy] Method 1: Using direct storage API: ${storageApiUrl}`);
      
      const serviceKey = process.env.SERVICE_SUPABASESERVICE_KEY;
      const anonKey = process.env.SERVICE_SUPABASEANON_KEY;
      
      if (!serviceKey && !anonKey) {
        throw new Error('No Supabase keys found');
      }
      
      // Use service key for authentication (this worked in our curl test)
      const authKey = serviceKey || anonKey;
      console.log(`[BookProxy] Using ${serviceKey ? 'service' : 'anon'} key for authentication`);
      
      const response = await fetch(storageApiUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authKey}`,
          'apikey': authKey,
          'Accept': '*/*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
        }
      });
      
      if (response.ok) {
        console.log(`[BookProxy] ✅ Method 1 successful with direct storage API`);
        return response;
      } else {
        const errorText = await response.text();
        console.log(`[BookProxy] Method 1 failed: ${response.status}`);
        console.log(`[BookProxy] Error details:`, errorText);
        throw new Error(`Direct storage API call failed: ${response.status}`);
      }
    } catch (directApiError) {
      console.log(`[BookProxy] Method 1 failed: ${directApiError.message}`);
      
      // Method 2: Try Supabase client as fallback
      try {
        console.log(`[BookProxy] Method 2: Using Supabase client fallback`);
        const { data, error } = await supabase.storage
          .from(bucketName)
          .createSignedUrl(filePath, 60); // 60 seconds expiry
        
        if (error) {
          console.log(`[BookProxy] Method 2 error:`, error);
          throw error;
        }
        
        if (!data?.signedUrl) {
          throw new Error('No signed URL returned from Supabase client');
        }
        
        console.log('[BookProxy] ✅ Got signed URL from client:', data.signedUrl);
        
        // Fetch using the signed URL
        const signedResponse = await fetch(data.signedUrl);
        if (signedResponse.ok) {
          console.log('[BookProxy] ✅ Successfully downloaded file using client signed URL');
          return signedResponse;
        } else {
          throw new Error(`Failed to download using client signed URL: ${signedResponse.status}`);
        }
      } catch (clientError) {
        console.log(`[BookProxy] Method 2 failed: ${clientError.message}`);
        throw clientError;
      }
    }
  } catch (error) {
    console.error('[BookProxy] Error with all Supabase methods:', error);
    // Fallback to direct fetch if all methods fail
    console.log('[BookProxy] Falling back to direct fetch');
    return await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
  }
}

async function handleS3Url(url) {
  console.log('[BookProxy] Handling S3 URL');
  // For S3 URLs, we can fetch directly
  return await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });
}

async function handleExternalUrl(url) {
  console.log('[BookProxy] Handling external URL');
  // For external URLs, use custom headers to avoid blocking
  return await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    },
    timeout: 30000 // 30 second timeout
  });
}

// API documentation endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'BookHub API Service',
    version: '1.0.0',
    endpoints: {
      // Book-related endpoints
      'GET /health': 'Enhanced health check with database connectivity test',
      'GET /books/search?query=<term>&page=<num>&limit=<num>&source=<source>': 'Search books from multiple sources',
      'POST /books/download': 'Download a book (requires url, title, author, format, category in body)',
      'POST /api/proxy/book-content': 'Proxy book content to resolve CORS issues (requires url and optional format in body)',
      'GET /books/:id': 'Get book details (not implemented)',
      'GET /test-download': 'Test download functionality',
      
      // Admin and diagnostic endpoints
      'GET /admin/database/diagnostics': 'Run database diagnostics to identify corrupted records',
      'GET /admin/network/diagnostics': 'Run comprehensive network and connectivity diagnostics',
      'DELETE /admin/database/cleanup/:bookId?confirm=true': 'Delete a corrupted book record and its S3 file',
      
      // AI API proxies
      'POST /api/openrouter/chat': 'OpenRouter Chat API proxy',
      'POST /api/huggingface/inference': 'Hugging Face Inference API proxy'
    },
    sources: {
      'ebook-hunter': 'https://ebook-hunter.org (default)',
      'annas-archive': 'https://annas-archive.org'
    },
    examples: {
      'Search ebook-hunter': '/books/search?query=javascript&source=ebook-hunter',
      'Search Anna\'s Archive': '/books/search?query=javascript&source=annas-archive',
      'Search default (ebook-hunter)': '/books/search?query=javascript',
      'Proxy book content': 'POST /api/proxy/book-content with { "url": "https://example.com/book.pdf", "format": "pdf" }',
      'Health check': 'GET /health',
      'Database diagnostics': 'GET /admin/database/diagnostics',
      'Network diagnostics': 'GET /admin/network/diagnostics',
      'Delete corrupted book': 'DELETE /admin/database/cleanup/book-id-here?confirm=true',
      'OpenRouter Chat': 'POST /api/openrouter/chat with standard OpenRouter chat completion payload',
      'Hugging Face': 'POST /api/huggingface/inference with model name and inference payload'
    },
    cors: 'Enabled for localhost development',
    diagnostics: {
      description: 'Enhanced error reporting and diagnostics available',
      healthCheck: 'Includes database connectivity test',
      networkDiagnostics: 'DNS resolution, HTTP connectivity, Supabase API, and database query tests'
    }
  });
});

// Redirect /download to /books/download for convenience
app.all('/download', (req, res) => {
  res.status(404).json({
    error: 'Endpoint moved',
    message: 'Please use POST /books/download instead of /download',
    correctEndpoint: '/books/download',
    method: 'POST',
    requiredBody: {
      url: 'string (required)',
      title: 'string (optional)',
      author: 'string (optional)', 
      format: 'string (optional)',
      category: 'string (optional)',
      coverImageUrl: 'string (optional)'
    }
  });
});

// Test download endpoint for debugging
app.get('/test-download', async (req, res) => {
  const testUrl = "https://tiny-files.com/67e70fe152f90e037bf1971e/31065647/Digital%20Art%20Live%20Issue%2040%20by%20tosk.pdf/";
  
  try {
    console.log('🧪 Testing download with URL:', testUrl);
    
    // Make a POST request to our own download endpoint
    const response = await fetch(`http://localhost:${PORT}/books/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        url: testUrl,
        title: "Digital Art Live Issue 40",
        author: "tosk",
        format: "pdf",
        category: "Art & Design"
      })
    });
    
    const responseData = await response.json();
    
    if (response.ok) {
      res.status(200).json({
        success: true,
        message: 'Test download completed successfully',
        data: responseData
      });
    } else {
      res.status(response.status).json({
        success: false,
        error: 'Test download failed',
        data: responseData
      });
    }
  } catch (error) {
    console.error('❌ Test download error:', error);
    res.status(500).json({
      success: false,
      error: 'Test download failed',
      message: error.message
    });
  }
});

// Books search API endpoint
app.get('/books/search', async (req, res) => {
  // Set JSON content type
  res.setHeader('Content-Type', 'application/json');
  
  try {
    console.log('🔍 Starting book search...');
    const query = req.query.query || '';
    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '10', 10);
    const source = req.query.source || DEFAULT_SOURCE;

    // Validate search parameters
    if (!query) {
      return res.status(400).json({ 
        error: 'Invalid search parameters',
        message: 'Query parameter is required',
        books: [],
        total: 0,
        page: 1,
        totalPages: 0
      });
    }

    // Validate source
    if (!BOOK_SOURCES[source]) {
      return res.status(400).json({ 
        error: 'Invalid source',
        message: `Source must be one of: ${Object.keys(BOOK_SOURCES).join(', ')}`,
        books: [],
        total: 0,
        page: 1,
        totalPages: 0
      });
    }

    console.log(`📚 Searching on ${source} for: "${query}"`);
    const baseUrl = getBaseUrl(source);

    let browser;
    try {
      // Launch browser with specific options
      console.log('🌐 Launching browser...');
      browser = await chromium.launch({
        headless: true,  // Changed to true for production environment
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      });
      
      const searchPage = await context.newPage();
      console.log('✅ Browser launched successfully');

      let allBooks = [];

      if (source === 'annas-archive') {
        // Anna's Archive search logic
        allBooks = await searchAnnasArchive(searchPage, query, baseUrl, context);
      } else {
        // Default ebook-hunter.org search logic
        allBooks = await searchEbookHunter(searchPage, query, baseUrl, context);
      }

      console.log('📚 Books with download URLs:', allBooks.length);
      
      // Apply pagination
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + limit;
      const paginatedBooks = allBooks.slice(startIndex, endIndex);
      
      const response = {
        books: paginatedBooks,
        total: allBooks.length,
        page,
        totalPages: Math.ceil(allBooks.length / limit),
        source
      };

      console.log('✅ Search completed successfully');
      
      // Send the response
      return res.json(response);
    } catch (error) {
      console.error('❌ Search error:', error);
      return res.status(500).json({ 
        error: 'Failed to search books', 
        message: error.message || 'Unknown error',
        books: [],
        total: 0,
        page: 1,
        totalPages: 0
      });
    } finally {
      // Ensure browser is always closed
      if (browser) {
        await browser.close();
        console.log('✅ Browser closed');
      }
    }
  } catch (error) {
    console.error('❌ Search error:', error);
    return res.status(500).json({ 
      error: 'Failed to search books', 
      message: error.message || 'Unknown error',
      books: [],
      total: 0,
      page: 1,
      totalPages: 0
    });
  }
});

// Anna's Archive search function
async function searchAnnasArchive(searchPage, query, baseUrl, context) {
  try {
    // Navigate to Anna's Archive search
    const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(query)}`;
    console.log('🔄 Navigating to Anna\'s Archive search URL:', searchUrl);
    await searchPage.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    console.log('✅ Anna\'s Archive search page loaded');

    // Extract book metadata from Anna's Archive
    const bookMetadata = await searchPage.evaluate((baseUrl) => {
      const results = [];
      
      // Anna's Archive uses different selectors - look for search result items
      document.querySelectorAll('div[class*="mb-"] a[href*="/md5/"]').forEach((linkElement) => {
        try {
          const href = linkElement.getAttribute('href');
          if (!href || !href.includes('/md5/')) return;

          // Get the parent container that has the book info
          const container = linkElement.closest('div[class*="mb-"]');
          if (!container) return;

          // Extract title from the link text or nearby elements
          const titleElement = linkElement.querySelector('h3') || linkElement;
          const title = titleElement.textContent?.trim();
          if (!title) return;

          // Look for metadata in the container
          const metadataText = container.textContent || '';
          
          // Extract format from common patterns
          const formatMatch = metadataText.match(/\.(pdf|epub|mobi|azw3|txt|doc|docx)\b/i);
          const format = formatMatch ? formatMatch[1].toLowerCase() : 'pdf';

          // Extract author - look for common patterns
          const authorMatch = metadataText.match(/(?:by|author[:\s]+)([^,\n\r]+)/i);
          const author = authorMatch ? authorMatch[1].trim() : 'Unknown Author';

          // Extract year if available
          const yearMatch = metadataText.match(/\b(19|20)\d{2}\b/);
          const year = yearMatch ? yearMatch[0] : '';

          // Build full URL
          const bookUrl = href.startsWith('http') ? href : `${baseUrl}${href}`;

          results.push({
            title,
            author,
            format,
            date: year,
            category: 'General',
            bookUrl,
            coverImageUrl: '', // Anna's Archive doesn't always have cover images in search
            source: 'annas-archive'
          });
        } catch (error) {
          console.error('Error parsing Anna\'s Archive result:', error);
        }
      });

      return results;
    }, baseUrl);

    console.log('📚 Anna\'s Archive books found:', bookMetadata.length);

    // For Anna's Archive, we need to get download URLs from individual book pages
    const allBooks = [];
    for (const metadata of bookMetadata.slice(0, 15)) { // Limit to avoid too many requests
      try {
        const bookPage = await context.newPage();
        const downloadInfo = await getAnnasArchiveDownloadUrl(bookPage, metadata.bookUrl);
        await bookPage.close();
        
        if (downloadInfo.downloadUrl) {
          allBooks.push({
            id: crypto.randomUUID(),
            ...metadata,
            downloadUrl: downloadInfo.downloadUrl,
            coverImageUrl: downloadInfo.coverImageUrl || metadata.coverImageUrl
          });
          console.log('✅ Got Anna\'s Archive download URL for:', metadata.title);
        }
      } catch (error) {
        console.error('❌ Failed to get Anna\'s Archive download URL for:', metadata.title, error);
      }
    }

    return allBooks;
  } catch (error) {
    console.error('❌ Anna\'s Archive search error:', error);
    return [];
  }
}

// Get download URL from Anna's Archive book page
async function getAnnasArchiveDownloadUrl(page, bookUrl) {
  try {
    console.log('📖 Navigating to Anna\'s Archive book page:', bookUrl);
    await page.goto(bookUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    const result = await page.evaluate(() => {
      // Look for download links - Anna's Archive typically has multiple download options
      const downloadLinks = document.querySelectorAll('a[href*="download"]');
      let downloadUrl = '';
      
      // Prefer direct download links
      for (const link of downloadLinks) {
        const href = link.getAttribute('href');
        if (href && (href.includes('libgen') || href.includes('sci-hub') || href.includes('download'))) {
          downloadUrl = href.startsWith('http') ? href : `https://annas-archive.org${href}`;
          break;
        }
      }

      // If no direct download found, look for the first available download link
      if (!downloadUrl && downloadLinks.length > 0) {
        const firstLink = downloadLinks[0];
        const href = firstLink.getAttribute('href');
        if (href) {
          downloadUrl = href.startsWith('http') ? href : `https://annas-archive.org${href}`;
        }
      }

      // Look for cover image
      const coverImg = document.querySelector('img[src*="cover"]') || document.querySelector('img[alt*="cover"]');
      const coverImageUrl = coverImg ? coverImg.getAttribute('src') : '';

      return { 
        downloadUrl,
        coverImageUrl: coverImageUrl && coverImageUrl.startsWith('http') ? coverImageUrl : ''
      };
    });

    return result;
  } catch (error) {
    console.error('❌ Failed to get Anna\'s Archive download URL:', error);
    return { downloadUrl: '', coverImageUrl: '' };
  }
}

// Existing ebook-hunter.org search function (extracted from original logic)
async function searchEbookHunter(searchPage, query, baseUrl, context) {
  // Navigate directly to search URL
  const searchUrl = `${baseUrl}/search/?keyword=${encodeURIComponent(query)}`;
  console.log('🔄 Navigating to ebook-hunter search URL:', searchUrl);
  await searchPage.goto(searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  console.log('✅ Ebook-hunter search page loaded');

  // Remove any overlay and wait for it to be gone
  console.log('🔍 Checking for advertisement overlay...');
  await searchPage.evaluate(() => {
    const adOverlay = document.querySelector('.pmjlvmd');
    if (adOverlay) {
      console.log('🗑️ Removing advertisement overlay');
      adOverlay.remove();
    }
  });

  // First collect all book metadata and page URLs
  const bookMetadata = await searchPage.evaluate((baseUrl) => {
    // Remove any overlay that might have appeared
    const adOverlay = document.querySelector('.pmjlvmd');
    if (adOverlay) {
      adOverlay.remove();
    }

    // Find all book entries - they're in div.index_box containers
    const results = [];
    
    // Look for book entries that match the structure in the DOM
    document.querySelectorAll('div.index_box').forEach((bookBox) => {
      // Get the title element which contains the link and metadata
      const titleElement = bookBox.querySelector('.index_box_title.list_title');
      if (!titleElement) return;

      // Get the link element
      const linkElement = titleElement.querySelector('a');
      if (!linkElement) return;

      // Extract the cover image URL if it exists
      const coverImageElement = bookBox.querySelector('.index_box_img img, .index_box_lit img');
      const coverImageSrc = coverImageElement?.getAttribute('src') || '';
      // Ensure we're getting the full URL, either already absolute or relative that we need to make absolute
      const coverImageUrl = coverImageSrc.startsWith('http') ? coverImageSrc : coverImageSrc ? `https://img.ebook-hunter.org${coverImageSrc}` : '';
      
      // Get the info element that contains metadata
      const infoElement = bookBox.querySelector('.index_box_info.list_title');
      const infoText = infoElement?.textContent || '';

      // Get the full text content for parsing
      const fullText = infoText.trim();
      
      // Parse the format (usually at the start, like "pdf |")
      const formatMatch = fullText.match(/^(\w+)\s*\|/);
      const format = formatMatch ? formatMatch[1].toLowerCase() : 'unknown';

      // Parse the date (usually in YYYY-MM-DD format)
      const dateMatch = fullText.match(/\|\s*(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : '';

      // Parse the author (usually after "Author:")
      const authorMatch = fullText.match(/Author:\s*([^|)]+)/);
      const author = authorMatch ? authorMatch[1].trim() : 'Unknown';

      // Parse the category (usually in parentheses with "Category:" prefix)
      const categoryMatch = fullText.match(/Category:\s*([^)]+)\)/);
      const category = categoryMatch ? categoryMatch[1].trim() : '';

      // Get the title from the link text
      const title = linkElement.textContent?.trim();
      if (!title) return; // Skip if no title found

      results.push({
        title,
        author,
        format,
        date,
        category,
        bookUrl: linkElement.href,
        coverImageUrl: coverImageUrl.startsWith('http') ? coverImageUrl : coverImageUrl ? `${baseUrl}${coverImageUrl}` : '',
        source: 'ebook-hunter'
      });
    });

    return results;
  }, baseUrl);

  console.log('📚 Ebook-hunter books found:', bookMetadata.length);

  // Function to extract cover image URL
  function extractCoverImageUrl(bookUrl, existingImageUrl) {
    // If we already have a valid image URL, use it
    if (existingImageUrl && existingImageUrl.startsWith('http')) {
      return existingImageUrl;
    }

    // Extract book identifier from URL
    const bookIdMatch = bookUrl.match(/\/([^/]+)\/$/);
    if (!bookIdMatch) return '';
    const bookId = bookIdMatch[1];

    // Construct image URL based on the pattern
    return `https://img.ebook-hunter.org/img/${bookId}_small.jpg`;
  }

  // Function to get book download URL
  async function getBookDownloadUrl(page, bookUrl) {
    try {
      // Navigate to the book's page
      console.log('📖 Navigating to book page:', bookUrl);
      await page.goto(bookUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Wait for and find the download link and cover image
      const result = await page.evaluate(() => {
        // Remove any overlay that might appear
        const adOverlay = document.querySelector('.pmjlvmd');
        if (adOverlay) adOverlay.remove();

        // Look for the download link in the to-lock section
        const downloadLink = document.querySelector('.to-lock a');
        
        // Look for cover image
        const coverImg = document.querySelector('.single_box_img img, .index_box_lit img');
        const coverSrc = coverImg?.getAttribute('src') || '';
        // Format the image URL correctly based on the site's structure
        const coverImageUrl = coverSrc.startsWith('http') ? coverSrc : coverSrc ? `https://img.ebook-hunter.org${coverSrc}` : '';
        
        return { 
          downloadUrl: downloadLink?.href || '',
          coverImageUrl
        };
      });

      if (!result.downloadUrl) {
        console.log('❌ No download link found on book page');
      }

      // Return the result
      return result;
    } catch (error) {
      console.error('❌ Failed to get book download URL:', error);
      return { downloadUrl: '' };
    }
  }

  // Process books sequentially to avoid race conditions
  const allBooks = [];
  for (const metadata of bookMetadata.slice(0, 20)) { // Limit to first 20 to avoid too many requests
    try {
      // Create a new page for each book to avoid navigation conflicts
      const bookPage = await context.newPage();
      const { downloadUrl, coverImageUrl: bookPageCoverImageUrl } = await getBookDownloadUrl(bookPage, metadata.bookUrl);
      await bookPage.close();
      if (downloadUrl) {
        allBooks.push({
          id: crypto.randomUUID(), // Add unique ID
          ...metadata,
          downloadUrl,
          coverImageUrl: extractCoverImageUrl(metadata.bookUrl, metadata.coverImageUrl || bookPageCoverImageUrl || ''),
        });
        console.log('✅ Got download URL for:', metadata.title);
      }
    } catch (error) {
      console.error('❌ Failed to get download URL for:', metadata.title, error);
    }
  }

  return allBooks;
}

// Book details API endpoint
app.get('/books/:id', (req, res) => {
  // For now, return a 404 as this endpoint isn't implemented yet
  res.status(404).json({
    error: 'Book not found',
    message: 'This endpoint is not fully implemented yet'
  });
});

// Book download URL API endpoint
app.post('/books/download', async (req, res) => {
  try {
    const { url, title, author, format, category, coverImageUrl } = req.body;
    console.log('🎯 Download requested for URL:', url);
    
    const downloadPath = process.env.DOWNLOAD_PATH || '/tmp/downloads';
    console.log('📂 Using download path:', downloadPath);

    if (!url || !url.startsWith('http')) {
      console.log('❌ Invalid URL format:', url);
      return res.status(400).json({
        error: 'Invalid URL',
        message: 'The download URL must be a valid HTTP/HTTPS URL'
      });
    }

    // Check if book already exists in database
    console.log('🔍 Checking if book already exists...');
    const existingBook = await checkBookExists(url);
    if (existingBook) {
      console.log('✅ Book already exists in database:', existingBook.id);
      return res.status(200).json({
        success: true,
        message: 'Book already exists in database',
        id: existingBook.id,
        s3_bucket_url: existingBook.s3_bucket_url
      });
    }

    let browser;
    let tempFilePath = null;

    try {
      await fs.promises.mkdir(downloadPath, { recursive: true });
      console.log('📁 Download directory ensured');

      // Launch browser with headless=false like Python (change to true for production)
      browser = await chromium.launch({
        headless: true, // Changed from true to match Python
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      // Configure context to match Python exactly
      const context = await browser.newContext({
        acceptDownloads: true,
        ignoreHTTPSErrors: true
      });

      const page = await context.newPage();
      console.log('📄 New page created');

      // Enhanced popup handling to prevent download interference
      context.on('page', async (newPage) => {
        try {
          const popupUrl = newPage.url();
          console.log(`🚫 Popup detected: ${popupUrl}. Closing immediately.`);
          
          // Close popup immediately without waiting
          if (!newPage.isClosed()) {
            await newPage.close();
            console.log(`✅ Popup closed: ${popupUrl}`);
          }
        } catch (error) {
          console.log(`⚠️ Error closing popup: ${error.message}`);
        }
      });

      // Block known ad/popup domains
      await page.route('**/*', (route) => {
        const url = route.request().url();
        const blockedDomains = [
          'etoro.com',
          'doubleclick.net',
          'googleadservices.com',
          'googlesyndication.com',
          'amazon-adsystem.com',
          'facebook.com/tr',
          'google-analytics.com'
        ];
        
        if (blockedDomains.some(domain => url.includes(domain))) {
          console.log(`🚫 Blocked request to: ${url}`);
          route.abort();
        } else {
          route.continue();
        }
      });

      console.log(`🔄 Navigating to ${url}...`);
      await page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: 60000 
      });
      console.log('✅ Page loaded');

      const downloadButtonSelector = 'input[type="submit"][id="btn_download"][value="Download File"]';
      let downloadInitiated = false;
      const maxRetries = 5; // Increased from 3
      let retryCount = 0;
      const maxWaitTime = 180000; // Reduced to 3 minutes
      const startTime = Date.now();

      while (!downloadInitiated && retryCount < maxRetries) {
        retryCount++;
        console.log(`🔄 Attempt ${retryCount} to download...`);

        try {
          // Keep checking for the download button every 3 seconds (reduced from 5)
          while (true) {
            const currentTime = Date.now();
            if (currentTime - startTime > maxWaitTime) {
              throw new Error('Maximum wait time exceeded (3 minutes)');
            }

            console.log('🔍 Checking for download button...');
            const button = page.locator(downloadButtonSelector);
            
            // Check if the button exists and is visible
            const buttonCount = await button.count();
            if (buttonCount > 0 && await button.isVisible()) {
              // Check if the button is within a div with class "to-lock"
              const parentDiv = button.locator('xpath=ancestor::div[@class="to-lock"]');
              const parentDivExists = await parentDiv.count() > 0;
              
              if (parentDivExists) {
                console.log('✅ Download button found and appears to be enabled!');
                
                try {
                  // Start waiting for the download BEFORE clicking with shorter timeout
                  console.log('👂 Setting up download event listener...');
                  const downloadPromise = page.waitForEvent('download', { timeout: 60000 }); // Reduced from 120000
                  
                  console.log('🖱️ Clicking download button...');
                  await button.click();
                  
                  console.log('⏳ Waiting for download to start...');
                  
                  // Add a race condition to handle popup interference
                  const downloadResult = await Promise.race([
                    downloadPromise,
                    new Promise((_, reject) => 
                      setTimeout(() => reject(new Error('Download timeout - likely popup interference')), 30000)
                    )
                  ]);
                  
                  const download = downloadResult;
                  console.log(`📥 Download started: ${download.suggestedFilename()}`);
                  tempFilePath = path.join(downloadPath, `temp_${Date.now()}_${download.suggestedFilename()}`);
                  
                  await download.saveAs(tempFilePath);
                  console.log(`💾 Download completed and saved to: ${tempFilePath}`);

                  // Verify file exists and has size (like Python)
                  const fileStats = await fs.promises.stat(tempFilePath);
                  if (fileStats.size > 0) {
                    console.log('📊 File successfully downloaded. Uploading to Supabase...');

                    // Prepare book metadata
                    const bookMetadata = {
                      title: title || download.suggestedFilename().replace(/\.[^/.]+$/, ""), // Remove extension
                      author: author || 'Unknown Author',
                      format: format || 'pdf',
                      category: category || null,
                      coverImageUrl: coverImageUrl || null,
                      downloadUrl: url,
                      bookUrl: url
                    };

                    // Upload to Supabase storage and insert into database
                    const supabaseResult = await uploadToSupabaseStorage(
                      tempFilePath, 
                      download.suggestedFilename(),
                      bookMetadata
                    );

                    console.log('✅ Book successfully uploaded to Supabase');
                    downloadInitiated = true;

                    // Return success response with book ID and S3 URL
                    return res.status(200).json({
                      success: true,
                      message: 'Book downloaded and uploaded successfully',
                      id: supabaseResult.id,
                      s3_bucket_url: supabaseResult.s3_bucket_url
                    });

                  } else {
                    console.log('❌ Download failed or file is empty.');
                    if (tempFilePath && fs.existsSync(tempFilePath)) {
                      await fs.promises.unlink(tempFilePath);
                    }
                    throw new Error('Downloaded file is empty');
                  }
                } catch (downloadError) {
                  console.error('❌ Error during download:', downloadError);
                  
                  // If it's a popup interference, wait a bit and retry
                  if (downloadError.message.includes('popup interference') || downloadError.message.includes('timeout')) {
                    console.log('🔄 Popup interference detected, waiting before retry...');
                    await page.waitForTimeout(3000);
                    break; // Break inner loop to retry
                  }
                  throw downloadError;
                }
              } else {
                console.log('⏳ Button found but parent div not ready. Waiting...');
              }
            } else {
              console.log('⏳ Download button not ready yet. Waiting 3 seconds...');
            }
            
            await page.waitForTimeout(3000); // Reduced from 5000
          }

          if (downloadInitiated) {
            break;
          }

        } catch (error) {
          console.error(`❌ Error during download attempt ${retryCount}:`, error);
          
          // Handle timeout errors and popup interference
          if (error.name === 'TimeoutError' || 
              error.message.includes('timeout') || 
              error.message.includes('Maximum wait time exceeded') ||
              error.message.includes('popup interference')) {
            
            if (retryCount >= maxRetries) {
              console.log('❌ Max retries reached. Could not download the file.');
              throw new Error('Download timeout after maximum retries');
            }
            
            console.log('🔄 Retrying after timeout/popup interference...');
            // Reload the page to reset state
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000); // Wait 2 seconds before next attempt
          } else {
            throw error;
          }
        }
      }

      if (!downloadInitiated) {
        throw new Error('Download failed after all attempts');
      }

    } catch (error) {
      console.error('❌ Download error:', error);
      return res.status(500).json({
        success: false,
        error: 'Download failed',
        message: error.message || 'An unexpected error occurred during download'
      });
    } finally {
      try {
        // Clean up temporary files
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          await fs.promises.unlink(tempFilePath);
          console.log('🧹 Temporary file cleaned up:', tempFilePath);
        }
      } catch (err) {
        console.error('❌ Error cleaning up temporary file:', err);
      }

      if (browser) {
        console.log('🔒 Closing browser...');
        await browser.close();
      }
    }
  } catch (error) {
    console.error('❌ Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: 'Fatal error',
      message: error.message || 'An unexpected error occurred'
    });
  }
});

// Database cleanup and diagnostic endpoint
app.get('/admin/database/diagnostics', async (req, res) => {
  try {
    console.log('🔍 Running database diagnostics...');
    
    // Get all books to check for potential issues
    const { data: books, error } = await supabase
      .from('books')
      .select('id, title, author, download_url, s3_bucket_url')
      .order('created_at', { ascending: false })
      .limit(100); // Limit to recent 100 books

    if (error) {
      console.error('❌ Error fetching books for diagnostics:', error);
      return res.status(500).json({ error: 'Failed to fetch books', details: error.message });
    }

    const issues = [];
    const stats = {
      total: books.length,
      withIssues: 0,
      urlMismatches: 0,
      potentialCorruption: 0
    };

    books.forEach(book => {
      const bookIssues = [];
      
      // Check for URL mismatches or corruption
      if (book.download_url && book.s3_bucket_url) {
        const downloadUrlParts = book.download_url.split('/');
        const downloadFilename = downloadUrlParts[downloadUrlParts.length - 1] || '';
        
        if (downloadFilename) {
          const baseFilename = downloadFilename.toLowerCase().split('.')[0];
          const s3UrlLower = book.s3_bucket_url.toLowerCase();
          
          // Check if the S3 URL contains something related to the download filename
          if (baseFilename.length > 3 && !s3UrlLower.includes(baseFilename)) {
            bookIssues.push('Filename mismatch between download_url and s3_bucket_url');
            stats.potentialCorruption++;
          }
        }
        
        // Check for obvious domain mismatches
        if (book.download_url.includes('tiny-files.com') && 
            book.s3_bucket_url.includes('supabase') && 
            !book.s3_bucket_url.toLowerCase().includes(book.title?.toLowerCase().split(' ')[0] || '')) {
          bookIssues.push('Domain and content mismatch detected');
          stats.urlMismatches++;
        }
      }
      
      if (bookIssues.length > 0) {
        issues.push({
          id: book.id,
          title: book.title,
          author: book.author,
          download_url: book.download_url,
          s3_bucket_url: book.s3_bucket_url,
          issues: bookIssues
        });
        stats.withIssues++;
      }
    });

    console.log(`📊 Database diagnostics completed. Found ${issues.length} potential issues.`);

    res.json({
      success: true,
      stats,
      issues: issues.slice(0, 20), // Return first 20 issues
      message: `Diagnostics completed. Found ${issues.length} books with potential issues out of ${books.length} checked.`
    });

  } catch (error) {
    console.error('❌ Error running database diagnostics:', error);
    res.status(500).json({ 
      error: 'Failed to run diagnostics', 
      details: error.message 
    });
  }
});

// Database cleanup endpoint to remove corrupted records
app.delete('/admin/database/cleanup/:bookId', async (req, res) => {
  try {
    const { bookId } = req.params;
    const { confirm } = req.query;
    
    if (confirm !== 'true') {
      return res.status(400).json({
        error: 'Confirmation required',
        message: 'Add ?confirm=true to the URL to confirm deletion'
      });
    }

    console.log(`🗑️ Attempting to delete book with ID: ${bookId}`);
    
    // First, get the book details to log what we're deleting
    const { data: book, error: fetchError } = await supabase
      .from('books')
      .select('*')
      .eq('id', bookId)
      .single();

    if (fetchError) {
      console.error('❌ Error fetching book for deletion:', fetchError);
      return res.status(404).json({ error: 'Book not found', details: fetchError.message });
    }

    console.log('📋 Book to be deleted:', {
      id: book.id,
      title: book.title,
      download_url: book.download_url,
      s3_bucket_url: book.s3_bucket_url
    });

    // Delete the book record
    const { error: deleteError } = await supabase
      .from('books')
      .delete()
      .eq('id', bookId);

    if (deleteError) {
      console.error('❌ Error deleting book:', deleteError);
      return res.status(500).json({ error: 'Failed to delete book', details: deleteError.message });
    }

    // Optionally, try to clean up the S3 file if it exists
    if (book.s3_bucket_id) {
      try {
        const { error: storageError } = await supabase.storage
          .from('books')
          .remove([book.s3_bucket_id]);
        
        if (storageError) {
          console.warn('⚠️ Failed to delete S3 file:', storageError);
        } else {
          console.log('🧹 Successfully deleted S3 file:', book.s3_bucket_id);
        }
      } catch (storageCleanupError) {
        console.warn('⚠️ Error during S3 cleanup:', storageCleanupError);
      }
    }

    console.log(`✅ Successfully deleted book: ${bookId}`);
    
    res.json({
      success: true,
      message: 'Book deleted successfully',
      deletedBook: {
        id: book.id,
        title: book.title,
        download_url: book.download_url
      }
    });

  } catch (error) {
    console.error('❌ Error in cleanup endpoint:', error);
    res.status(500).json({ 
      error: 'Failed to delete book', 
      details: error.message 
    });
  }
});

// Serve React app for all other routes (if dist directory exists)
if (fs.existsSync(path.join(__dirname, 'dist'))) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📚 Book API endpoints available at http://localhost:${PORT}/books/*`);
  console.log(`🤖 AI API proxies available at http://localhost:${PORT}/api/*`);
  console.log(`🔮 OpenRouter (Google Gemma) available at http://localhost:${PORT}/api/openrouter/chat`);
}); 

// Custom Supabase client that uses direct PostgreSQL connection
function createCustomSupabaseClient(pgClient, apiKey) {
  console.log('🔧 Creating custom PostgreSQL-based Supabase client...');
  return {
    from: (table) => ({
      select: (columns = '*') => ({
        eq: (column, value) => ({
          single: async () => {
            try {
              const query = `SELECT ${columns} FROM ${table} WHERE ${column} = $1 LIMIT 1`;
              const result = await pgClient.unsafe(query, [value]);
              return { data: result[0] || null, error: null };
            } catch (error) {
              return { data: null, error: { message: error.message, code: 'CUSTOM_PG_ERROR' } };
            }
          }
        }),
        limit: (limit) => ({
          single: async () => {
            try {
              const query = `SELECT ${columns} FROM ${table} LIMIT ${limit}`;
              const result = await pgClient.unsafe(query);
              return { data: result[0] || null, error: null };
            } catch (error) {
              return { data: null, error: { message: error.message, code: 'CUSTOM_PG_ERROR' } };
            }
          }
        }),
        single: async () => {
          try {
            const query = `SELECT ${columns} FROM ${table} LIMIT 1`;
            const result = await pgClient.unsafe(query);
            return { data: result[0] || null, error: null };
          } catch (error) {
            return { data: null, error: { message: error.message, code: 'CUSTOM_PG_ERROR' } };
          }
        }
      })
    }),
    storage: {
      from: () => ({
        createSignedUrl: () => ({ data: null, error: { message: 'Storage not available with direct PG connection' } }),
        upload: () => ({ data: null, error: { message: 'Storage not available with direct PG connection' } }),
        remove: () => ({ error: { message: 'Storage not available with direct PG connection' } }),
        getPublicUrl: () => ({ data: { publicUrl: '' } })
      })
    }
  };
} 

// Network diagnosis endpoint for production troubleshooting
app.get('/admin/network/detailed-diagnostics', async (req, res) => {
  try {
    console.log('🔧 Running detailed network diagnostics...');
    
    const diagnostics = {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      container_info: {
        hostname: process.env.HOSTNAME || 'unknown',
        coolify_url: process.env.COOLIFY_URL || 'not_set',
        host: process.env.HOST || 'not_set'
      },
      dns_tests: {},
      connectivity_tests: {},
      supabase_tests: {}
    };
    
    // Test 1: DNS Resolution (multiple methods)
    const hostname = 'supabasekong-g00sk4cwgwk0cwkc8kcgc8gk.bookzify.xyz';
    try {
      const { promisify } = await import('util');
      const dns = await import('dns');
      const lookup = promisify(dns.lookup);
      
      console.log(`🔍 Testing DNS resolution for: ${hostname}`);
      const dnsResult = await lookup(hostname);
      
      diagnostics.dns_tests.lookup = {
        status: 'success',
        hostname,
        resolved_ip: dnsResult.address,
        family: dnsResult.family
      };
      
      // Also test direct IP connectivity
      console.log(`🔍 Testing direct IP connectivity to: ${dnsResult.address}`);
      const ipTest = await fetch(`https://${dnsResult.address}`, {
        method: 'HEAD',
        timeout: 5000,
        headers: { 'Host': hostname }
      });
      
      diagnostics.connectivity_tests.direct_ip = {
        status: 'success',
        ip: dnsResult.address,
        response_code: ipTest.status
      };
      
    } catch (dnsError) {
      diagnostics.dns_tests.lookup = {
        status: 'failed',
        error: {
          name: dnsError.name,
          message: dnsError.message,
          code: dnsError.code
        }
      };
    }
    
    // Test 2: Basic HTTP connectivity with different timeouts
    const timeouts = [2000, 5000, 10000];
    for (const timeout of timeouts) {
      try {
        console.log(`🌐 Testing HTTP connectivity with ${timeout}ms timeout...`);
        const response = await fetch(`https://${hostname}`, {
          method: 'HEAD',
          timeout
        });
        
        diagnostics.connectivity_tests[`timeout_${timeout}`] = {
          status: 'success',
          response_code: response.status,
          timeout_used: timeout
        };
        break; // If one works, we don't need to test longer timeouts
        
      } catch (httpError) {
        diagnostics.connectivity_tests[`timeout_${timeout}`] = {
          status: 'failed',
          timeout_used: timeout,
          error: {
            name: httpError.name,
            message: httpError.message,
            code: httpError.code,
            cause: httpError.cause?.code || 'unknown'
          }
        };
      }
    }
    
    // Test 3: Supabase API specific tests
    try {
      console.log('🔗 Testing Supabase REST API...');
      const apiUrl = `https://${hostname}/rest/v1/`;
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        },
        timeout: 15000
      });
      
      diagnostics.supabase_tests.rest_api = {
        status: response.ok ? 'success' : 'failed',
        url: apiUrl,
        status_code: response.status,
        status_text: response.statusText,
        headers: Object.fromEntries(response.headers.entries())
      };
      
    } catch (supabaseError) {
      diagnostics.supabase_tests.rest_api = {
        status: 'failed',
        error: {
          name: supabaseError.name,
          message: supabaseError.message,
          code: supabaseError.code,
          cause: supabaseError.cause?.code || 'unknown'
        }
      };
    }
    
    // Test 4: PostgreSQL direct connection (if credentials available)
    if (process.env.POSTGRES_PASSWORD) {
      try {
        console.log('💾 Testing direct PostgreSQL connection...');
        const postgres = await import('postgres');
        
        const pgClient = postgres.default({
          host: 'supabase-db',
          port: 5432,
          database: 'postgres',
          username: 'postgres',
          password: process.env.POSTGRES_PASSWORD,
          connect_timeout: 10
        });
        
        const result = await pgClient`SELECT 1 as test`;
        if (result && result.length > 0) {
          diagnostics.supabase_tests.postgresql_direct = {
            status: 'success',
            connection: 'supabase-db:5432',
            test_query: 'SELECT 1'
          };
        }
        
        await pgClient.end();
        
      } catch (pgError) {
        diagnostics.supabase_tests.postgresql_direct = {
          status: 'failed',
          error: {
            name: pgError.name,
            message: pgError.message,
            code: pgError.code
          }
        };
      }
    }
    
    // Summary
    const tests = [
      ...Object.values(diagnostics.dns_tests),
      ...Object.values(diagnostics.connectivity_tests),
      ...Object.values(diagnostics.supabase_tests)
    ];
    
    const passedTests = tests.filter(test => test.status === 'success').length;
    const totalTests = tests.length;
    
    diagnostics.summary = {
      total_tests: totalTests,
      passed: passedTests,
      failed: totalTests - passedTests,
      overall_status: passedTests > 0 ? (passedTests === totalTests ? 'all_passed' : 'partial') : 'all_failed',
      recommendations: []
    };
    
    // Add recommendations based on results
    if (diagnostics.dns_tests.lookup?.status === 'failed') {
      diagnostics.summary.recommendations.push('DNS resolution failed - check container network configuration');
    }
    
    if (diagnostics.supabase_tests.postgresql_direct?.status === 'success') {
      diagnostics.summary.recommendations.push('Direct PostgreSQL works - can use as fallback');
    }
    
    if (Object.values(diagnostics.connectivity_tests).every(test => test.status === 'failed')) {
      diagnostics.summary.recommendations.push('All HTTP connectivity failed - network isolation issue');
    }
    
    console.log(`📊 Detailed diagnostics completed: ${diagnostics.summary.overall_status}`);
    
    const statusCode = diagnostics.summary.overall_status === 'all_failed' ? 500 : 200;
    res.status(statusCode).json(diagnostics);
    
  } catch (error) {
    console.error('❌ Error running detailed diagnostics:', error);
    res.status(500).json({
      error: 'Failed to run detailed diagnostics',
      details: error.message
    });
  }
}); 

// Debug endpoint to show environment variables in production
app.get('/admin/debug/env', (req, res) => {
  const debugInfo = {
    NODE_ENV: process.env.NODE_ENV,
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ? 'SET' : 'NOT_SET',
    SUPABASE_URL: process.env.SUPABASE_URL,
    all_postgres_vars: Object.keys(process.env).filter(key => 
      key.toLowerCase().includes('postgres') || 
      key.toLowerCase().includes('pg') ||
      key.toLowerCase().includes('database') ||
      key.toLowerCase().includes('db')
    ).map(key => `${key}=${process.env[key] ? 'SET' : 'NOT_SET'}`),
    production_check: process.env.NODE_ENV === 'production',
    container_info: {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
      hostname: process.env.HOSTNAME || 'unknown'
    }
  };
  
  res.json(debugInfo);
});