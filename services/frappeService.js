const axios = require('axios');
require('dotenv').config({ path: './config.env' });

/**
 * 🔗 Frappe Service - Social Service
 * Service để tương tác với Frappe ERP API
 * Pattern tương tự ticket-service và inventory-service
 */
class FrappeService {
  constructor() {
    this.baseURL = process.env.FRAPPE_API_URL || 'https://admin.sis.wellspring.edu.vn';
    this.apiKey = process.env.FRAPPE_API_KEY;
    this.apiSecret = process.env.FRAPPE_API_SECRET;
    // Bật đồng bộ Frappe mặc định nếu không cấu hình
    this.enabled = (process.env.ENABLE_FRAPPE_SYNC || 'true') === 'true';
    this.timeout = parseInt(process.env.AUTH_TIMEOUT) || 20000;

    this.api = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    // Chỉ thêm API Key/Secret khi request chưa có Authorization sẵn
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

  /**
   * 🔐 Build auth headers cho request
   */
  buildAuthHeaders(token) {
    if (!token) return {};
    return {
      'Authorization': `Bearer ${token}`,
      'X-Frappe-CSRF-Token': token,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  /**
   * 🔑 Xác thực user bằng Bearer token từ mobile app
   */
  async authenticateUser(token) {
    if (!this.enabled) throw new Error('Frappe sync is disabled');

    const commonHeaders = this.buildAuthHeaders(token);

    // 1) Thử endpoint ERP tuỳ biến (ưu tiên vì app mobile đang dùng)
    const url = '/api/method/erp.api.erp_common_user.auth.get_current_user';
    try {
      console.log('[FrappeService] → GET', `${this.baseURL}${url}`);

      const erpResp = await this.api.get(url, { headers: commonHeaders });
      console.log('[FrappeService] ← ERP status:', erpResp.status);

      const raw = erpResp.data;
      const data = raw && (raw.message || raw);
      
      // Check various response structures from Frappe
      if (data) {
        // Structure 1: { success: true, data: { user: {...} } }
        if (data.success === true && data.data && data.data.user) {
          console.log('[FrappeService] ✅ ERP auth successful (structure 1)');
          return data.data.user;
        }
        // Structure 2: { status: 'success', user: {...} }
        if (data.status === 'success' && data.user) {
          console.log('[FrappeService] ✅ ERP auth successful (structure 2)');
          return data.user;
        }
        // Structure 3: { user: {...}, authenticated: true }
        if (data.user && data.authenticated === true) {
          console.log('[FrappeService] ✅ ERP auth successful (structure 3)');
          return data.user;
        }
        // Structure 4: Just { user: {...} } without explicit authenticated flag
        if (data.user && data.authenticated !== false) {
          console.log('[FrappeService] ✅ ERP auth successful (structure 4 - implicit)');
          return data.user;
        }
      }
      
      try { console.warn('[FrappeService] ERP responded but not authenticated, data:', JSON.stringify(data).substring(0, 200)); } catch {}
    } catch (e) {
      console.error('[FrappeService] ERP request failed:', e?.message);
    }

    // 2) Fallback: Nếu Bearer không được map session, coi như không xác thực
    throw new Error('Frappe did not accept Bearer token');
  }

  /**
   * 📋 Lấy chi tiết user từ Frappe theo email
   * @param {string} userEmail - User email hoặc username
   * @param {string} token - Bearer token
   */
  async getUserDetail(userEmail, token) {
    try {
      console.log(`[FrappeService] Fetching user detail: ${userEmail}`);
      
      const response = await this.api.get(`/api/resource/User/${userEmail}`, {
        headers: this.buildAuthHeaders(token)
      });

      if (!response.data?.data) {
        throw new Error('Invalid user data from Frappe');
      }

      const user = response.data.data;
      
      // Normalize roles
      const roles = Array.isArray(user.roles)
        ? user.roles.map(r => typeof r === 'string' ? r : r?.role).filter(Boolean)
        : [];

      return {
        name: user.name,
        email: user.email || user.name,
        full_name: user.full_name || user.first_name,
        first_name: user.first_name,
        middle_name: user.middle_name,
        last_name: user.last_name,
        roles: roles,
        enabled: user.enabled === 1 ? 1 : 0,
        disabled: user.disabled,
        docstatus: user.docstatus,
        user_image: user.user_image || '',
        department: user.department || '',
        location: user.location,
        job_title: user.job_title,
        designation: user.designation,
        phone: user.phone || '',
        mobile_no: user.mobile_no || '',
        employee_code: user.employee_code,
        microsoft_id: user.microsoft_id,
        user_type: user.user_type,
      };
    } catch (error) {
      console.error(`[FrappeService] Get user detail failed for ${userEmail}:`, error.message);
      return null;
    }
  }

  /**
   * 👥 Lấy tất cả enabled users từ Frappe
   * Sử dụng custom endpoint để lấy tất cả users trong 1 request
   * @param {string} token - Bearer token
   */
  async getAllEnabledUsers(token) {
    try {
      console.log('[FrappeService] Fetching all enabled users from Frappe...');

      // Gọi custom endpoint để lấy ALL users trong 1 request
      const response = await this.api.get(
        '/api/method/erp.api.erp_common_user.user_sync.get_all_enabled_users',
        { headers: this.buildAuthHeaders(token) }
      );

      const result = response.data.message || response.data;
      
      if (!result.success) {
        throw new Error(result.error || result.message || 'Failed to fetch users');
      }

      const users = result.data || [];
      const userTypeStats = result.user_types || {};

      console.log(`[FrappeService] ✅ Found ${users.length} enabled users`);
      console.log(`[FrappeService] 📊 User Types: System=${userTypeStats['System User'] || 0}, Website=${userTypeStats['Website User'] || 0}`);

      // Return users với format chuẩn
      return users.map(user => ({
        name: user.name,
        email: user.email || user.name,
        full_name: user.full_name,
        first_name: user.first_name,
        middle_name: user.middle_name,
        last_name: user.last_name,
        user_image: user.user_image,
        enabled: user.enabled,
        disabled: user.disabled,
        location: user.location,
        department: user.department,
        job_title: user.job_title,
        designation: user.designation,
        employee_code: user.employee_code,
        microsoft_id: user.microsoft_id,
        docstatus: user.docstatus,
        user_type: user.user_type,
        roles: user.roles || [],
      }));
    } catch (error) {
      console.error('[FrappeService] Error fetching enabled users:', error.message);
      if (error.response) {
        console.error('[FrappeService] Response status:', error.response.status);
      }
      return [];
    }
  }

  /**
   * 📄 Lấy danh sách users theo page (fallback khi custom endpoint không khả dụng)
   * @param {string} token - Bearer token  
   * @param {number} page - Page number (0-based)
   * @param {number} pageSize - Number of users per page
   */
  async getUsersPage(token, page = 0, pageSize = 100) {
    try {
      console.log(`[FrappeService] Fetching users page ${page}, size ${pageSize}`);

      const response = await this.api.get('/api/resource/User', {
        params: {
          fields: JSON.stringify([
            'name', 'email', 'full_name', 'first_name', 'middle_name', 'last_name',
            'user_image', 'enabled', 'disabled', 'docstatus', 'location', 'department',
            'job_title', 'designation', 'employee_code', 'microsoft_id', 'user_type'
          ]),
          filters: JSON.stringify([['User', 'enabled', '=', 1]]),
          limit_start: page * pageSize,
          limit_page_length: pageSize,
          order_by: 'name asc'
        },
        headers: this.buildAuthHeaders(token)
      });

      const users = response.data?.data || [];
      console.log(`[FrappeService] Fetched ${users.length} users from page ${page}`);
      return users;
    } catch (error) {
      console.error('[FrappeService] Get users page failed:', error.message);
      return [];
    }
  }

  /**
   * 🔍 Verify token và lấy thông tin user hiện tại
   * @param {string} token - Bearer token
   */
  async verifyTokenAndGetUser(token) {
    try {
      console.log('[FrappeService] Verifying token with Frappe...');
      
      // Bước 1: Lấy logged user
      const userResponse = await this.api.get('/api/method/frappe.auth.get_logged_user', {
        headers: this.buildAuthHeaders(token)
      });

      if (!userResponse.data?.message) {
        throw new Error('No user information in Frappe response');
      }

      const userName = userResponse.data.message;
      console.log(`[FrappeService] ✅ Token verified. User: ${userName}`);

      // Bước 2: Lấy full user details
      const userDetails = await this.getUserDetail(userName, token);
      return userDetails;
    } catch (error) {
      console.error('[FrappeService] Token verification failed:', error.message);
      throw new Error(`Frappe token verification failed: ${error.message}`);
    }
  }

  /**
   * 📝 Gọi Frappe method
   * @param {string} methodName - Method name trong format 'module.method_name'
   * @param {Object} params - Parameters
   * @param {string} token - Bearer token
   */
  async callMethod(methodName, params = {}, token) {
    try {
      console.log(`[FrappeService] Calling method: ${methodName}`);
      
      const response = await this.api.post(`/api/method/${methodName}`, params, {
        headers: this.buildAuthHeaders(token)
      });

      console.log(`[FrappeService] ✅ Method ${methodName} executed successfully`);
      return response.data?.message;
    } catch (error) {
      console.error(`[FrappeService] Call method failed (${methodName}):`, error.message);
      throw error;
    }
  }

  /**
   * 📨 Gửi Wislife notification đến Frappe
   * Pattern giống ticket-service: local auth với headers X-Service-Name và X-Request-Source
   * @param {string} eventType - Event type (e.g., 'new_post_broadcast', 'post_reacted')
   * @param {Object} eventData - Event data
   */
  async sendWislifeNotification(eventType, eventData) {
    const MAX_RETRIES = 2;
    const TIMEOUT_MS = 10000; // 10 giây - Frappe chỉ enqueue job, respond nhanh
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[FrappeService] 📱 Sending Wislife notification: ${eventType} (attempt ${attempt}/${MAX_RETRIES})`);
        
        const response = await axios.post(
          `${this.baseURL}/api/method/erp.api.notification.wislife.handle_wislife_event`,
          {
            event_type: eventType,
            event_data: eventData
          },
          {
            timeout: TIMEOUT_MS,
            headers: {
              'X-Service-Name': 'social-service',
              'X-Request-Source': 'service-to-service',
              'Content-Type': 'application/json'
            }
          }
        );

        if (response.data?.message?.success !== false) {
          console.log(`[FrappeService] ✅ Wislife notification sent: ${eventType}`);
          return { success: true };
        } else {
          console.warn(`[FrappeService] ⚠️ Wislife notification response:`, response.data);
          return { success: false, message: response.data?.message };
        }
      } catch (error) {
        const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
        console.error(`[FrappeService] ❌ Notification failed (${eventType}), attempt ${attempt}: ${error.message}`);
        
        // Retry nếu timeout và chưa hết retry
        if (isTimeout && attempt < MAX_RETRIES) {
          console.log(`[FrappeService] 🔄 Retrying in 2 seconds...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        
        if (error.response) {
          console.error(`[FrappeService] Response status: ${error.response.status}`);
        }
        return { success: false, message: error.message };
      }
    }
    return { success: false, message: 'Max retries exceeded' };
  }
}

module.exports = new FrappeService();

