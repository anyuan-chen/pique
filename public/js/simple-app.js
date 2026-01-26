/**
 * Pique - Minimal App
 */

class SimpleApp {
  constructor() {
    this.restaurantId = null;
    this.voice = null;

    this.init();
  }

  init() {
    // Elements
    this.uploadBox = document.getElementById('upload-box');
    this.videoInput = document.getElementById('video-input');
    this.voiceBtn = document.getElementById('voice-btn');
    this.backBtn = document.getElementById('back-btn');
    this.status = document.getElementById('status');
    this.toast = document.getElementById('toast');

    // Events
    this.uploadBox.onclick = () => this.videoInput.click();
    this.videoInput.onchange = (e) => this.upload(e.target.files[0]);

    this.voiceBtn.onmousedown = () => this.startVoice();
    this.voiceBtn.onmouseup = () => this.stopVoice();
    this.voiceBtn.onmouseleave = () => this.stopVoice();
    this.voiceBtn.ontouchstart = (e) => { e.preventDefault(); this.startVoice(); };
    this.voiceBtn.ontouchend = () => this.stopVoice();

    this.backBtn.onclick = () => this.reset();
  }

  show(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`${screen}-screen`).classList.add('active');
  }

  async upload(file) {
    if (!file || !file.type.startsWith('video/')) return;

    this.show('processing');

    try {
      const form = new FormData();
      form.append('video', file);

      const res = await fetch('/api/upload/video', { method: 'POST', body: form });
      const { jobId } = await res.json();

      this.poll(jobId);
    } catch (e) {
      this.notify('Error', 'error');
      this.show('upload');
    }
  }

  async poll(jobId) {
    try {
      const res = await fetch(`/api/upload/status/${jobId}`);
      const data = await res.json();

      if (data.status === 'completed') {
        this.restaurantId = data.restaurantId;
        this.show('voice');
        this.initVoice();
      } else if (data.status === 'failed') {
        this.notify('Error', 'error');
        this.show('upload');
      } else {
        setTimeout(() => this.poll(jobId), 1500);
      }
    } catch (e) {
      setTimeout(() => this.poll(jobId), 2000);
    }
  }

  async initVoice() {
    if (this.voice) this.voice.disconnect();

    this.voice = new VoiceClient({
      restaurantId: this.restaurantId,
      onReady: () => this.status.textContent = '',
      onText: (t) => this.status.textContent = t,
      onToolExecuted: (tool, args, result) => {
        this.notify(result.success ? '✓' : '✗', result.success ? 'success' : 'error');
      },
      onError: () => this.notify('Error', 'error'),
      onDisconnected: () => setTimeout(() => this.initVoice(), 2000)
    });

    try {
      await this.voice.connect();
    } catch (e) {
      this.status.textContent = '...';
    }
  }

  async startVoice() {
    if (!this.voice?.isConnected) return;
    try {
      await this.voice.startListening();
      this.voiceBtn.classList.add('active');
      this.status.textContent = '';
    } catch (e) {
      this.notify('🎤?', 'error');
    }
  }

  stopVoice() {
    this.voice?.stopListening();
    this.voiceBtn.classList.remove('active');
  }

  reset() {
    this.voice?.disconnect();
    this.voice = null;
    this.restaurantId = null;
    this.videoInput.value = '';
    this.show('upload');
  }

  notify(msg, type) {
    this.toast.textContent = msg;
    this.toast.className = `toast show ${type}`;
    setTimeout(() => this.toast.classList.remove('show'), 2000);
  }
}

document.addEventListener('DOMContentLoaded', () => new SimpleApp());
