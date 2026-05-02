const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const path = require('path');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

let upload;

if (process.env.CLOUDINARY_CLOUD_NAME) {
  // Imagens via CloudinaryStorage
  const imageStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'stilus-planejados',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    },
  });
  upload = multer({ storage: imageStorage, limits: { fileSize: 8 * 1024 * 1024 } });
} else {
  const fs = require('fs');
  const uploadDir = path.join(__dirname, '../public/uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  });
  upload = multer({ storage: imageStorage, limits: { fileSize: 8 * 1024 * 1024 } });
}

// Vídeo: usa memória e faz upload manual para o Cloudinary
const uploadVideoMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Apenas vídeos MP4, MOV, AVI, WEBM'), false);
  },
});

// Função auxiliar para fazer upload de buffer para o Cloudinary
function uploadVideoToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'stilus-videos',
        resource_type: 'video',
        public_id: `vid_${Date.now()}`,
        eager: [{ format: 'mp4', transformation: [{ quality: 'auto' }] }],
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    const { Readable } = require('stream');
    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);
    readable.pipe(stream);
  });
}

module.exports = upload;
module.exports.uploadVideoMiddleware = uploadVideoMiddleware;
module.exports.uploadVideoToCloudinary = uploadVideoToCloudinary;
module.exports.cloudinary = cloudinary;

