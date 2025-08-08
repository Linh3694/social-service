const axios = require('axios');
require('dotenv').config({ path: './config.env' });

class FrappeService {
  constructor() {
    this.baseURL = process.env.FRAPPE_API_URL || 'https://admin.sis.wellspring.edu.vn';
    this.apiKey = process.env.FRAPPE_API_KEY;
    this.apiSecret = process.env.FRAPPE_API_SECRET;
    this.enabled = process.env.ENABLE_FRAPPE_SYNC === 'true';

    this.api = axios.create({
      baseURL: this.baseURL,
      timeout: 20000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    this.api.interceptors.request.use((config) => {
      if (this.apiKey && this.apiSecret) {
        config.headers['Authorization'] = `token ${this.apiKey}:${this.apiSecret}`;
      }
      return config;
    });
  }

  async authenticateUser(token) {
    if (!this.enabled) throw new Error('Frappe sync is disabled');
    const me = await this.api.get('/api/method/frappe.auth.get_logged_user', {
      headers: { Authorization: `Bearer ${token}`, 'X-Frappe-CSRF-Token': token },
    });
    const userId = me.data?.message;
    if (!userId) throw new Error('Invalid Frappe auth response');
    const userRes = await this.api.get(`/api/resource/User/${userId}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Frappe-CSRF-Token': token },
    });
    return userRes.data?.data;
  }
}

module.exports = new FrappeService();

