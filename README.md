# 🎥 Chroma Subtitle Studio

**Chroma Subtitle Studio** is a high-performance, portable web application for AI-powered transcription and video subtitling. It features an innovative "Client-First" architecture that runs AI and video encoding directly in your browser.

![License](https://img.shields.io/badge/license-UNLICENSED-blue.svg)
![Python](https://img.shields.io/badge/python-3.7+-green.svg)
![FFmpeg](https://img.shields.io/badge/ffmpeg-required-orange.svg)

## ✨ Key Features

- **🚀 In-Browser AI:** Transcription is powered by [Whisper (OpenAI)](https://github.com/openai/whisper) running entirely in your browser via Transformers.js. No server-side GPUs or API keys required!
- **⚡ Fast MP4 Export:** Uses the modern **WebCodecs API** for hardware-accelerated video encoding directly in the browser.
- **🟢 Green Screen Preview:** Real-time preview with a chroma-key background, perfect for overlaying subtitles on other video projects.
- **📦 Zero-Config Backend:** A lightweight Python server that handles file management and final FFmpeg conversions with zero external dependencies.
- **💾 Portable:** Works offline once the model is cached in the browser.

## 🛠️ Requirements

- **Python 3.x**
- **FFmpeg** (installed and added to your system PATH)

## 🚀 Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/chroma-subtitle-studio.git
   cd chroma-subtitle-studio
   ```

2. **Start the server:**
   ```bash
   python server.py
   ```

3. **Open the App:**
   Navigate to [http://127.0.0.1:5176/](http://127.0.0.1:5176/) in your browser (Chrome/Edge recommended for best performance).

## 📂 Project Structure

- `server.py`: Lightweight Python backend (standard library only).
- `index.html`: The Studio interface.
- `app.js`: Core logic for AI transcription, canvas rendering, and WebCodecs encoding.
- `styles.css`: Modern, responsive UI styling.
- `exports/`: Local directory where processed videos are saved.

## 🤝 Contributing

Feel free to open issues or submit pull requests to improve the transcription accuracy or rendering features!

## 📜 License

This project is currently UNLICENSED. (Update as needed)
