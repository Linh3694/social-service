const axios = require('axios');
require('dotenv').config({ path: './config.env' });

class FrappeService {
  constructor() {
    this.baseURL = process.env.FRAPPE_API_URL || 'https://admin.sis.wellspring.edu.vn';
    this.apiKey = process.env.FRAPPE_API_KEY;
    this.apiSecret = process.env.FRAPPE_API_SECRET;
    // Bật đồng bộ Frappe mặc định nếu không cấu hình (tránh break auth ở môi trường chưa khai báo biến)
    this.enabled = (process.env.ENABLE_FRAPPE_SYNC || 'true') === 'true';

    this.api = axios.create({
      baseURL: this.baseURL,
      timeout: 20000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    // Chỉ thêm API Key/Secret khi request chưa có Authorization sẵn (ví dụ Bearer từ mobile)
    this.api.interceptors.request.use((config) => {
      const headers = config.headers || {};
      const hasAuthorizationHeader = Object.keys(headers).some(
        (key) => key.toLowerCase() === 'authorization'
      );
      if (this.apiKey && this.apiSecret && !hasAuthorizationHeader) {
        headers['Authorization'] = `token ${this.apiKey}:${this.apiSecret}`;
      }
      config.headers = headers;
      return config;
    });
  }

  async authenticateUser(token) {
    if (!this.enabled) throw new Error('Frappe sync is disabled');

    const commonHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    // 1) Thử endpoint ERP tuỳ biến (ưu tiên vì app mobile đang dùng)
    try {
      const erpResp = await this.api.get(
        '/api/method/erp.api.erp_common_user.auth.get_current_user',
        { headers: commonHeaders }
      );
      const data = erpResp.data;
      if (data?.status === 'success' && data?.user && data?.authenticated) {
        return data.user;
      }
    } catch (e) {
      // Tiếp tục fallback dưới
    }

    // 2) Fallback: dùng phương thức chuẩn của Frappe
    const me = await this.api.get('/api/method/frappe.auth.get_logged_user', {
      headers: { ...commonHeaders, 'X-Frappe-CSRF-Token': token },
    });
    const userId = me.data?.message;
    if (!userId) throw new Error('Invalid Frappe auth response');
    const userRes = await this.api.get(`/api/resource/User/${userId}`, {
      headers: { ...commonHeaders, 'X-Frappe-CSRF-Token': token },
    });
    return userRes.data?.data;
  }
}

module.exports = new FrappeService();

