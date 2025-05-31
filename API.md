# BookHub API Documentation

## Base URL
```
Development: http://localhost:5005
Production: https://your-domain.com
```

## Authentication
Currently, the API does not require authentication for requests. However, it uses API keys for third-party services (OpenRouter, Hugging Face, Supabase) which are configured server-side.

## CORS
CORS is enabled for all routes with the following configuration:
- Development: All localhost origins
- Production: Configured domains only

## API Endpoints

### Health Check
```http
GET /health
```
Returns the health status of the API and its dependent services.

#### Response
```json
{
  "status": "healthy",
  "timestamp": "2024-03-11T12:00:00Z",
  "services": {
    "openrouter": true,
    "huggingface": true,
    "supabase": true
  }
}
```

### Book Search
```http
GET /books/search
```
Search for books across multiple sources.

#### Query Parameters
| Parameter | Type   | Required | Default | Description                                    |
|-----------|--------|----------|---------|------------------------------------------------|
| query     | string | Yes      | -       | Search term                                   |
| page      | number | No       | 1       | Page number for pagination                    |
| limit     | number | No       | 10      | Number of results per page                    |
| source    | string | No       | "ebook-hunter" | Book source ("ebook-hunter" or "annas-archive") |

#### Response
```json
{
  "books": [
    {
      "id": "uuid",
      "title": "Book Title",
      "author": "Author Name",
      "format": "pdf",
      "date": "2024-03-11",
      "category": "Programming",
      "bookUrl": "https://...",
      "coverImageUrl": "https://...",
      "downloadUrl": "https://...",
      "source": "ebook-hunter"
    }
  ],
  "total": 100,
  "page": 1,
  "totalPages": 10,
  "source": "ebook-hunter"
}
```

### Book Download
```http
POST /books/download
```
Download a book and store it in Supabase storage.

#### Request Body
```json
{
  "url": "https://...",
  "title": "Book Title",
  "author": "Author Name",
  "format": "pdf",
  "category": "Programming",
  "coverImageUrl": "https://..."
}
```

#### Response
```json
{
  "success": true,
  "message": "Book downloaded and uploaded successfully",
  "id": "uuid",
  "s3_bucket_url": "https://..."
}
```

### OpenRouter Chat API Proxy
```http
POST /api/openrouter/chat
```
Proxy endpoint for OpenRouter's chat completions API using Google Gemma models.

#### Request Body
Standard OpenRouter chat completion payload:
```json
{
  "model": "google/gemma-3n-e4b-it:free",
  "messages": [
    {
      "role": "user",
      "content": "Hello, how are you?"
    }
  ],
  "temperature": 0.7
}
```

**Available Models:**
- `google/gemma-2-9b-it:free` (default if no model specified)
- `google/gemma-3n-e4b-it:free` (as requested)

#### Response
Standard OpenRouter chat completion response (compatible with OpenAI format).

### Hugging Face Inference API Proxy
```http
POST /api/huggingface/inference
```
Proxy endpoint for Hugging Face's inference API.

#### Request Body
```json
{
  "model": "model-name",
  "inputs": "Your input text or data",
  "parameters": {
    // Model-specific parameters
  }
}
```

#### Response
- JSON response for text/classification models
- Binary data for audio/image models

## Error Handling

All endpoints follow a consistent error response format:

```json
{
  "error": "Error type",
  "message": "Detailed error message",
  "details": "Additional error details (optional)"
}
```

Common HTTP Status Codes:
- 200: Success
- 400: Bad Request
- 404: Not Found
- 500: Internal Server Error

## Rate Limiting
Currently, no rate limiting is implemented. However, the underlying services (OpenAI, Hugging Face) may have their own rate limits.

## Environment Variables
Required environment variables for the API:

```env
# Supabase Configuration
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key

# AI Services
VITE_OPENROUTER_API_KEY=your_openrouter_api_key
VITE_HUGGINGFACE_API_KEY=your_huggingface_api_key

# Optional Configuration
PORT=5005                   # Default: 5005
NODE_ENV=development       # or production
DOWNLOAD_PATH=/tmp/downloads # Default: /tmp/downloads
```

## Examples

### Search Books
```bash
curl "http://localhost:5005/books/search?query=javascript&source=ebook-hunter&page=1&limit=10"
```

### Download Book
```bash
curl -X POST "http://localhost:5005/books/download" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/book.pdf",
    "title": "JavaScript Basics",
    "author": "John Doe",
    "format": "pdf",
    "category": "Programming"
  }'
```

### OpenRouter Chat
```bash
curl -X POST "http://localhost:5005/api/openrouter/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemma-3n-e4b-it:free",
    "messages": [
      {
        "role": "user",
        "content": "Hello, how are you?"
      }
    ]
  }'
```

### Hugging Face Inference
```bash
curl -X POST "http://localhost:5005/api/huggingface/inference" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt2",
    "inputs": "Hello, how are"
  }'
```

## Support
For issues or questions, please open an issue in the repository or contact the maintainers.

## License
[Your License Information] 