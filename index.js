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

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SERVICE_SUPABASEANON_KEY || process.env.SUPABASE_ANON_KEY;

// Validate required environment variables
const requiredEnvVars = {
  'SUPABASE_URL': supabaseUrl,
  'SERVICE_SUPABASEANON_KEY or SUPABASE_ANON_KEY': supabaseKey,
  'VITE_OPENROUTER_API_KEY': process.env.VITE_OPENROUTER_API_KEY,
  'VITE_HUGGINGFACE_API_KEY': process.env.VITE_HUGGINGFACE_API_KEY
};

const missingEnvVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

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

// Helper function to check if book already exists
async function checkBookExists(downloadUrl) {
  try {
    const { data, error } = await supabase
      .from('books')
      .select('id, s3_bucket_url')
      .eq('download_url', downloadUrl)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found" error
      console.error('❌ Error checking book existence:', error);
      throw error;
    }

    return data; // Returns null if not found, or book data if found
  } catch (error) {
    console.error('❌ Error in checkBookExists:', error);
    throw error;
  }
}

const app = express();
const PORT = process.env.PORT || 5005;

// Enhanced CORS configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? [
        // Add your production domain here
        'https://bookzify.xyz',
        'https://www.bookzify.xyz'
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
    'Origin'
  ]
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// CORS debugging middleware (only in development)
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin) {
      console.log(`🌐 CORS: Request from origin: ${origin}`);
    }
    next();
  });
}

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
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    services: {
      openrouter: !!process.env.VITE_OPENROUTER_API_KEY,
      huggingface: !!process.env.VITE_HUGGINGFACE_API_KEY,
      supabase: !!process.env.SUPABASE_URL
    }
  });
});

// Diagnostic endpoint for troubleshooting production issues
app.get('/diagnostic', async (req, res) => {
  const testUrl = req.query.url || 'https://supabasekong-g00sk4cwgwk0cwkc8kcgc8gk.bookzify.xyz/storage/v1/object/public/books/test.txt';
  
  console.log('[Diagnostic] Starting connectivity test...');
  
  const diagnostics = {
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    testUrl,
    results: {
      dnsResolution: null,
      basicConnectivity: null,
      supabaseAuth: null,
      alternativeUrls: []
    },
    recommendations: []
  };

  try {
    // Test 1: DNS Resolution
    console.log('[Diagnostic] Testing DNS resolution...');
    try {
      const url = new URL(testUrl);
      const hostname = url.hostname;
      
      // Try to resolve the hostname
      const dns = await import('dns/promises');
      const addresses = await dns.lookup(hostname);
      diagnostics.results.dnsResolution = {
        status: 'success',
        hostname,
        addresses: Array.isArray(addresses) ? addresses : [addresses],
        message: 'DNS resolution successful'
      };
      console.log('[Diagnostic] ✅ DNS resolution successful');
    } catch (dnsError) {
      diagnostics.results.dnsResolution = {
        status: 'error',
        error: dnsError.message,
        message: 'DNS resolution failed'
      };
      diagnostics.recommendations.push('DNS resolution failed. Check network connectivity and DNS settings.');
      console.log('[Diagnostic] ❌ DNS resolution failed:', dnsError.message);
    }

    // Test 2: Basic connectivity with different timeout values
    console.log('[Diagnostic] Testing basic connectivity...');
    const timeouts = [5000, 15000, 30000]; // 5s, 15s, 30s
    
    for (const timeout of timeouts) {
      try {
        console.log(`[Diagnostic] Trying ${timeout}ms timeout...`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        const response = await fetch(testUrl, {
          method: 'HEAD',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Bookzify-Diagnostic/1.0'
          }
        });
        
        clearTimeout(timeoutId);
        
        diagnostics.results.basicConnectivity = {
          status: 'success',
          statusCode: response.status,
          timeout: timeout,
          headers: Object.fromEntries(response.headers.entries()),
          message: `Connection successful with ${timeout}ms timeout`
        };
        console.log('[Diagnostic] ✅ Basic connectivity successful');
        break;
      } catch (connectError) {
        console.log(`[Diagnostic] ❌ Failed with ${timeout}ms timeout:`, connectError.message);
        if (timeout === timeouts[timeouts.length - 1]) {
          // Last attempt failed
          diagnostics.results.basicConnectivity = {
            status: 'error',
            error: connectError.message,
            timeoutsTested: timeouts,
            message: 'All connectivity tests failed'
          };
          diagnostics.recommendations.push('Basic connectivity failed. Check firewall settings and network access.');
        }
      }
    }

    // Test 3: Supabase authentication test
    console.log('[Diagnostic] Testing Supabase authentication...');
    try {
      const serviceKey = process.env.SERVICE_SUPABASESERVICE_KEY;
      const anonKey = process.env.SERVICE_SUPABASEANON_KEY;
      
      if (serviceKey || anonKey) {
        const authKey = serviceKey || anonKey;
        const keyType = serviceKey ? 'service' : 'anon';
        
        const authResponse = await fetch(testUrl, {
          method: 'HEAD',
          headers: {
            'Authorization': `Bearer ${authKey}`,
            'apikey': authKey
          },
          signal: AbortSignal.timeout(15000)
        });
        
        diagnostics.results.supabaseAuth = {
          status: 'success',
          keyType,
          statusCode: authResponse.status,
          message: `Authentication test successful with ${keyType} key`
        };
        console.log('[Diagnostic] ✅ Supabase authentication successful');
      } else {
        diagnostics.results.supabaseAuth = {
          status: 'error',
          error: 'No Supabase keys found',
          message: 'No authentication keys available for testing'
        };
        diagnostics.recommendations.push('No Supabase authentication keys found. Check environment variables.');
      }
    } catch (authError) {
      diagnostics.results.supabaseAuth = {
        status: 'error',
        error: authError.message,
        message: 'Supabase authentication test failed'
      };
      diagnostics.recommendations.push('Supabase authentication failed. Check API keys and permissions.');
      console.log('[Diagnostic] ❌ Supabase authentication failed:', authError.message);
    }

    // Test 4: Alternative URL patterns
    console.log('[Diagnostic] Testing alternative URL patterns...');
    const urlObj = new URL(testUrl);
    const alternativeUrls = [
      testUrl.replace('supabasekong-', '').replace('.bookzify.xyz', '.supabase.co'),
      `${urlObj.protocol}//${urlObj.host.replace('supabasekong-', '')}/storage/v1/object/public/books/`,
      `https://${urlObj.host.replace('.bookzify.xyz', '.supabase.co')}/storage/v1/object/public/books/`
    ];

    for (const altUrl of alternativeUrls) {
      try {
        const altResponse = await fetch(altUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(10000)
        });
        
        diagnostics.results.alternativeUrls.push({
          url: altUrl,
          status: 'success',
          statusCode: altResponse.status,
          message: 'Alternative URL accessible'
        });
        console.log('[Diagnostic] ✅ Alternative URL works:', altUrl);
      } catch (altError) {
        diagnostics.results.alternativeUrls.push({
          url: altUrl,
          status: 'error',
          error: altError.message,
          message: 'Alternative URL failed'
        });
        console.log('[Diagnostic] ❌ Alternative URL failed:', altUrl, altError.message);
      }
    }

    // Generate final recommendations
    if (diagnostics.results.dnsResolution?.status === 'success' && 
        diagnostics.results.basicConnectivity?.status === 'error') {
      diagnostics.recommendations.push('DNS works but connections fail. Check firewall rules and security groups.');
    }

    if (diagnostics.results.basicConnectivity?.status === 'success' && 
        diagnostics.results.supabaseAuth?.status === 'error') {
      diagnostics.recommendations.push('Basic connectivity works but auth fails. Check Supabase configuration.');
    }

    const workingAlternatives = diagnostics.results.alternativeUrls.filter(alt => alt.status === 'success');
    if (workingAlternatives.length > 0) {
      diagnostics.recommendations.push(`Consider using alternative URL patterns: ${workingAlternatives.map(alt => alt.url).join(', ')}`);
    }

    if (diagnostics.recommendations.length === 0) {
      diagnostics.recommendations.push('All tests passed. The connectivity issue may be intermittent.');
    }

  } catch (error) {
    console.error('[Diagnostic] ❌ Diagnostic test error:', error);
    diagnostics.results.error = error.message;
    diagnostics.recommendations.push('Diagnostic test failed. Check server logs for details.');
  }

  console.log('[Diagnostic] Test completed');
  res.json(diagnostics);
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
    
    // Production-optimized fetch configuration
    const fetchConfig = {
      method: 'GET',
      headers: {
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Connection': 'keep-alive',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      // Increase timeout for production (30 seconds instead of default 10)
      signal: AbortSignal.timeout(30000)
    };
    
    // Method 1: Use direct storage API endpoint with enhanced error handling
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
        ...fetchConfig,
        headers: {
          ...fetchConfig.headers,
          'Authorization': `Bearer ${authKey}`,
          'apikey': authKey
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
      
      // Method 2: Try alternative URL patterns for production
      try {
        console.log(`[BookProxy] Method 2: Trying alternative URL patterns`);
        
        // Try different URL configurations that might work better in production
        const alternativeUrls = [
          // Original public URL
          url,
          // Direct API endpoint without authentication
          `${urlObj.protocol}//${urlObj.host}/storage/v1/object/public/${bucketName}/${filePath}`,
          // Try with different subdomain pattern
          url.replace('supabasekong-', '').replace('.bookzify.xyz', '.supabase.co')
        ];
        
        for (const altUrl of alternativeUrls) {
          try {
            console.log(`[BookProxy] Trying alternative URL: ${altUrl}`);
            const altResponse = await fetch(altUrl, fetchConfig);
            
            if (altResponse.ok) {
              console.log(`[BookProxy] ✅ Alternative URL successful: ${altUrl}`);
              return altResponse;
            }
          } catch (altError) {
            console.log(`[BookProxy] Alternative URL failed: ${altUrl} - ${altError.message}`);
            continue;
          }
        }
        
        throw new Error('All alternative URLs failed');
      } catch (altUrlError) {
        console.log(`[BookProxy] Method 2 failed: ${altUrlError.message}`);
        
        // Method 3: Try Supabase client as fallback with increased timeout
        try {
          console.log(`[BookProxy] Method 3: Using Supabase client fallback`);
          
          // Create a custom fetch function with longer timeout for Supabase client
          const customFetch = (url, options = {}) => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
            
            return fetch(url, {
              ...options,
              signal: controller.signal
            }).finally(() => clearTimeout(timeoutId));
          };
          
          // Create a Supabase client with custom fetch
          const prodSupabase = createClient(supabaseUrl, supabaseKey, {
            global: {
              fetch: customFetch
            }
          });
          
          const { data, error } = await prodSupabase.storage
            .from(bucketName)
            .createSignedUrl(filePath, 300); // 5 minutes expiry
          
          if (error) {
            console.log(`[BookProxy] Method 3 error:`, error);
            throw error;
          }
          
          if (!data?.signedUrl) {
            throw new Error('No signed URL returned from Supabase client');
          }
          
          console.log('[BookProxy] ✅ Got signed URL from client:', data.signedUrl);
          
          // Fetch using the signed URL with extended timeout
          const signedResponse = await fetch(data.signedUrl, fetchConfig);
          if (signedResponse.ok) {
            console.log('[BookProxy] ✅ Successfully downloaded file using client signed URL');
            return signedResponse;
          } else {
            throw new Error(`Failed to download using client signed URL: ${signedResponse.status}`);
          }
        } catch (clientError) {
          console.log(`[BookProxy] Method 3 failed: ${clientError.message}`);
          throw clientError;
        }
      }
    }
  } catch (error) {
    console.error('[BookProxy] Error with all Supabase methods:', error);
    
    // Method 4: Final fallback - try direct fetch with production-optimized settings
    console.log('[BookProxy] Method 4: Final fallback with optimized direct fetch');
    try {
      return await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        // Extended timeout for production
        signal: AbortSignal.timeout(45000), // 45 seconds
        // Add these for better production compatibility
        keepalive: false,
        redirect: 'follow'
      });
    } catch (finalError) {
      console.error('[BookProxy] All methods failed, including final fallback:', finalError);
      throw new Error(`All connection methods failed. Last error: ${finalError.message}`);
    }
  }
}

async function handleS3Url(url) {
  console.log('[BookProxy] Handling S3 URL');
  // For S3 URLs, use production-optimized fetch
  return await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': '*/*',
      'Connection': 'keep-alive'
    },
    signal: AbortSignal.timeout(30000), // 30 second timeout
    redirect: 'follow'
  });
}

async function handleExternalUrl(url) {
  console.log('[BookProxy] Handling external URL');
  // For external URLs, use custom headers with production optimizations
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
    signal: AbortSignal.timeout(30000), // 30 second timeout
    redirect: 'follow'
  });
}

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
    console.log(`[BookProxy] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[BookProxy] Using service key:`, process.env.SERVICE_SUPABASESERVICE_KEY ? 'Yes' : 'No');
    console.log(`[BookProxy] Using anon key:`, process.env.SERVICE_SUPABASEANON_KEY ? 'Yes' : 'No');

    // Handle different URL types
    let response;
    
    try {
      if (url.includes('supabase')) {
        response = await handleSupabaseUrl(url);
      } else if (url.includes('s3.amazonaws.com') || url.includes('amazonaws.com')) {
        response = await handleS3Url(url);
      } else {
        response = await handleExternalUrl(url);
      }
    } catch (connectionError) {
      console.error(`[BookProxy] ❌ Connection error: ${connectionError.message}`);
      
      // If this is a connection timeout, provide specific guidance
      if (connectionError.message.includes('timeout') || connectionError.message.includes('TIMEOUT')) {
        return res.status(504).json({
          error: 'Gateway Timeout',
          message: 'Unable to connect to the book storage service. This may be a temporary network issue.',
          details: connectionError.message,
          retryAfter: 30,
          troubleshooting: {
            suggestion: 'Please try again in a few moments. If the issue persists, the storage service may be temporarily unavailable.',
            isTemporary: true
          }
        });
      }
      
      // If this is a DNS or host resolution error
      if (connectionError.message.includes('ENOTFOUND') || connectionError.message.includes('getaddrinfo')) {
        return res.status(502).json({
          error: 'Bad Gateway',
          message: 'Unable to resolve the book storage service. This may be a DNS or network configuration issue.',
          details: connectionError.message,
          troubleshooting: {
            suggestion: 'Please check your network connection and try again.',
            isTemporary: false
          }
        });
      }
      
      // Generic connection error
      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'Unable to connect to the book storage service.',
        details: connectionError.message,
        troubleshooting: {
          suggestion: 'Please try again later. If the issue persists, contact support.',
          isTemporary: true
        }
      });
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unable to read error response');
      console.error(`[BookProxy] ❌ Error fetching content: ${response.status} ${response.statusText}`);
      console.error(`[BookProxy] Error details:`, errorText);
      
      // Provide more specific error messages based on status codes
      let errorMessage = 'Failed to fetch book content';
      let troubleshooting = {};
      
      switch (response.status) {
        case 403:
          errorMessage = 'Access denied to book content';
          troubleshooting = {
            suggestion: 'The book may be restricted or require authentication.',
            isTemporary: false
          };
          break;
        case 404:
          errorMessage = 'Book content not found';
          troubleshooting = {
            suggestion: 'The book may have been moved or deleted.',
            isTemporary: false
          };
          break;
        case 429:
          errorMessage = 'Too many requests to book storage service';
          troubleshooting = {
            suggestion: 'Please wait a moment before trying again.',
            isTemporary: true,
            retryAfter: 60
          };
          break;
        case 500:
        case 502:
        case 503:
        case 504:
          errorMessage = 'Book storage service is temporarily unavailable';
          troubleshooting = {
            suggestion: 'Please try again in a few minutes.',
            isTemporary: true,
            retryAfter: 120
          };
          break;
        default:
          troubleshooting = {
            suggestion: 'Please try again or contact support if the issue persists.',
            isTemporary: true
          };
      }
      
      return res.status(response.status).json({
        error: errorMessage,
        details: `${response.status} ${response.statusText}`,
        troubleshooting,
        serverResponse: errorText.substring(0, 500) // Limit error response size
      });
    }

    // Get content type from response headers
    const contentType = response.headers.get('content-type') || 'unknown';
    console.log(`[BookProxy] 📄 Content-Type from source:`, contentType);

    // Determine response type based on format
    const isTextFormat = format && ['txt', 'html'].includes(format.toLowerCase());
    
    let contentSize = 0;
    let responseData;

    try {
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
    } catch (dataProcessingError) {
      console.error('[BookProxy] ❌ Error processing response data:', dataProcessingError);
      return res.status(500).json({
        error: 'Failed to process book content',
        message: 'The book content was received but could not be processed.',
        details: dataProcessingError.message,
        troubleshooting: {
          suggestion: 'The book file may be corrupted or in an unsupported format.',
          isTemporary: false
        }
      });
    }

  } catch (error) {
    console.error('[BookProxy] ❌ Unexpected error:', error);
    res.status(500).json({
      error: 'Internal server error while fetching book content',
      message: 'An unexpected error occurred on the server.',
      details: error.message,
      troubleshooting: {
        suggestion: 'Please try again. If the issue persists, contact support.',
        isTemporary: true
      }
    });
  }
});

// API documentation endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'BookHub API Service',
    version: '1.0.0',
    endpoints: {
      // Health and diagnostic endpoints
      'GET /health': 'Health check with service status',
      'GET /diagnostic': 'Network connectivity diagnostic tool (supports ?url= parameter)',
      
      // Book-related endpoints
      'GET /books/search?query=<term>&page=<num>&limit=<num>&source=<source>': 'Search books from multiple sources',
      'POST /books/download': 'Download a book (requires url, title, author, format, category in body)',
      'POST /api/proxy/book-content': 'Proxy book content to resolve CORS issues (requires url and optional format in body)',
      'GET /books/:id': 'Get book details (not implemented)',
      'GET /test-download': 'Test download functionality',
      
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
      'OpenRouter Chat': 'POST /api/openrouter/chat with standard OpenRouter chat completion payload',
      'Hugging Face': 'POST /api/huggingface/inference with model name and inference payload',
      'Diagnostic test': '/diagnostic or /diagnostic?url=https://your-supabase-url.com/file.pdf'
    },
    troubleshooting: {
      'Connection timeouts': 'Use /diagnostic endpoint to test connectivity',
      'Supabase issues': 'Check environment variables and use /diagnostic for testing',
      'CORS errors': 'Use /api/proxy/book-content endpoint instead of direct requests'
    },
    cors: 'Enabled for localhost development and production domains'
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
        headless: true, // Changed from false to true for production
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
        headless: true, // Changed from false to true for production
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