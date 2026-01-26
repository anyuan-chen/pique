/**
 * Restaurant AI - Minimal voice interface
 */

const SAMPLE_RATE = 16000;

class VoiceApp {
  constructor() {
    this.messagesEl = document.getElementById('messages');
    this.statusEl = document.getElementById('status');
    this.waveform = document.getElementById('waveform');
    this.actionBtn = document.getElementById('action-btn');
    this.actionIcon = document.getElementById('action-icon');
    this.fileInput = document.getElementById('file-input');

    this.ws = null;
    this.isConnected = false;
    this.isRecording = false;
    this.audioContext = null;
    this.mediaStream = null;
    this.processor = null;
    this.audioQueue = [];
    this.isPlaying = false;
    this.messages = [];
    this.mode = 'mic'; // 'mic' or 'upload'

    this.actionBtn.addEventListener('click', () => this.handleAction());
    this.fileInput.addEventListener('change', (e) => this.handleFile(e));

    this.init();
  }

  async init() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch (err) {
      this.setStatus('Mic access needed');
    }
  }

  handleAction() {
    if (this.mode === 'upload') {
      this.fileInput.click();
    } else {
      this.toggleRecording();
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.actionIcon.setAttribute('data-lucide', mode === 'upload' ? 'upload' : 'mic');
    lucide.createIcons();
  }


  setStatus(text) {
    this.statusEl.textContent = text;
  }

  addMessage(text, isCurrent = true) {
    // Mark all previous messages as past
    this.messages.forEach(m => m.current = false);

    // Add new message
    this.messages.push({ text, current: isCurrent });

    // Keep only last 5 messages
    if (this.messages.length > 5) {
      this.messages.shift();
    }

    this.renderMessages();
  }

  renderMessages() {
    this.messagesEl.innerHTML = this.messages.map(m =>
      `<div class="message${m.current ? ' current' : ''}">${this.formatText(m.text)}</div>`
    ).join('');
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  formatText(text) {
    // Convert URLs to links
    return text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
  }

  showImage(url) {
    const last = this.messages[this.messages.length - 1];
    if (last) {
      last.text += `<img src="${url}" alt=""><span class="share" onclick="app.share('${url}')">Share</span>`;
      this.renderMessages();
    }
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/api/voice?mode=general`);

    this.setStatus('Connecting...');

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ type: 'start' }));
    };

    this.ws.onmessage = (e) => this.handleMessage(JSON.parse(e.data));

    this.ws.onerror = () => {
      this.setStatus('Connection error');
      this.isConnected = false;
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      if (this.isRecording) this.stopRecording();
    };
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.isConnected = true;
        this.setStatus('Listening...');
        break;

      case 'audio':
        this.queueAudio(msg.data);
        break;

      case 'text':
        // Only show text if it contains actionable content (URLs)
        // Don't display spoken words - user hears those
        if (msg.text.includes('http') || msg.text.includes('.com')) {
          this.addMessage(msg.text);
        }
        // Check if Gemini is asking for upload
        if (/upload|video|file/i.test(msg.text) && /please|need|share/i.test(msg.text)) {
          this.setMode('upload');
        }
        break;

      case 'toolStarted':
        this.setStatus(this.toolStatus(msg.tool));
        this.waveform.classList.add('active');
        break;

      case 'toolCompleted':
        this.waveform.classList.remove('active');
        this.setStatus('Done');
        if (msg.result?.imageUrl) this.showImage(msg.result.imageUrl);
        if (msg.result?.websiteUrl) this.addMessage(msg.result.websiteUrl);
        if (msg.result?.youtubeUrl) this.addMessage(msg.result.youtubeUrl);
        break;

      case 'toolError':
        this.waveform.classList.remove('active');
        this.setStatus('Error');
        break;

      case 'error':
        this.setStatus('Error');
        break;
    }
  }

  toolStatus(tool) {
    const map = {
      'create_restaurant': 'Processing video...',
      'create_website': 'Generating website...',
      'create_youtube_short': 'Creating short...',
      'generate_graphic': 'Generating...',
      'modify_website': 'Updating...'
    };
    return map[tool] || 'Working...';
  }

  async toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  async startRecording() {
    if (!this.isConnected) {
      this.connect();
      const check = setInterval(() => {
        if (this.isConnected) {
          clearInterval(check);
          this.beginCapture();
        }
      }, 100);
      setTimeout(() => clearInterval(check), 10000);
      return;
    }
    this.beginCapture();
  }

  async beginCapture() {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });

      this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.isRecording || this.ws?.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          pcm[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
        }
        this.ws.send(JSON.stringify({ type: 'audio', data: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))) }));
      };

      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.isRecording = true;
      this.actionBtn.classList.add('active');
      this.waveform.classList.add('active');
      this.setStatus('Listening...');
    } catch (err) {
      this.setStatus('Mic error');
    }
  }

  stopRecording() {
    this.isRecording = false;
    this.processor?.disconnect();
    this.mediaStream?.getTracks().forEach(t => t.stop());
    this.audioContext?.close();
    this.processor = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.actionBtn.classList.remove('active');
    this.waveform.classList.remove('active');
    this.setStatus('Tap to continue');
  }

  queueAudio(base64) {
    this.audioQueue.push(base64);
    if (!this.isPlaying) this.playNext();
  }

  async playNext() {
    if (!this.audioQueue.length) { this.isPlaying = false; return; }
    this.isPlaying = true;
    const data = this.audioQueue.shift();

    try {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const ctx = new AudioContext({ sampleRate: 24000 });
      const pcm = new Int16Array(bytes.buffer);
      const float = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 32768;

      const buffer = ctx.createBuffer(1, float.length, 24000);
      buffer.getChannelData(0).set(float);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => { ctx.close(); this.playNext(); };
      source.start();
    } catch (err) {
      this.playNext();
    }
  }

  handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    this.uploadFile(file);
  }

  async uploadFile(file) {
    this.setStatus('Uploading...');
    const form = new FormData();
    form.append('video', file);

    try {
      const res = await fetch('/api/upload/video', { method: 'POST', body: form });
      const { filename, error } = await res.json();
      if (error) throw new Error(error);

      this.setStatus('Uploaded');
      this.setMode('mic'); // Switch back to mic after upload

      if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'text', text: `[Video uploaded: /uploads/${filename}]` }));
      }
    } catch (err) {
      this.setStatus('Upload failed');
    }

    this.fileInput.value = '';
  }

  async share(url) {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], 'image.png', { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
      } else {
        window.open(url, '_blank');
      }
    } catch (err) {
      window.open(url, '_blank');
    }
  }
}

const app = new VoiceApp();
