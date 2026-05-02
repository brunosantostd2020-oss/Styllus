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
let uploadVideo;

if (process.env.CLOUDINARY_CLOUD_NAME) {
  // Storage para imagens
  const imageStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'stilus-planejados',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    },
  });
  upload = multer({ storage: imageStorage, limits: { fileSize: 8 * 1024 * 1024 } });

  // Storage para vídeos
  const videoStorage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: 'stilus-videos',
      resource_type: 'video',
      allowed_formats: ['mp4', 'mov', 'avi', 'webm'],
    },
  });
  uploadVideo = multer({ storage: videoStorage, limits: { fileSize: 100 * 1024 * 1024 } });

} else {
  // Fallback local
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
  const fileFilter = (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Apenas imagens sao permitidas'), false);
  };
  upload = multer({ storage: imageStorage, fileFilter, limits: { fileSize: 8 * 1024 * 1024 } });

  const videoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `vid_${Date.now()}${ext}`);
    },
  });
  uploadVideo = multer({ storage: videoStorage, limits: { fileSize: 100 * 1024 * 1024 } });
}

module.exports = upload;
module.exports.uploadVideo = uploadVideo;
module.exports.cloudinary = cloudinary;

