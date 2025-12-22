/**
 * 🏷️ Mention Utility - Social Service
 * 
 * Xử lý mention (@) trong các nội dung như comment, post
 * Hỗ trợ: Parse mentions, validate users, format cho hiển thị
 */

const User = require('../models/User');
const { removeVietnameseTones } = require('./nameUtils');

/**
 * Regex để detect mention trong text
 * Hỗ trợ tên Việt Nam có dấu, nhiều từ
 * Format: @Nguyễn Văn An hoặc @[userId]
 */
const MENTION_REGEX = {
  // @[userId] format - dùng khi đã chọn user cụ thể từ dropdown
  BY_ID: /@\[([a-f0-9]{24})\]/gi,
  
  // @Tên Người Dùng format - detect tên có thể có dấu, 2-4 từ
  BY_NAME: /@([A-ZÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ][a-zàáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]*(?:\s+[A-ZÀÁẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬĐÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴ][a-zàáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]*){0,3})/g
};

/**
 * Parse mentions từ text content
 * @param {string} content - Nội dung cần parse
 * @returns {Object} - { byId: string[], byName: string[] }
 */
function parseMentions(content) {
  if (!content || typeof content !== 'string') {
    return { byId: [], byName: [] };
  }

  const result = {
    byId: [],
    byName: []
  };

  // Parse mentions by ID (@[userId])
  let match;
  while ((match = MENTION_REGEX.BY_ID.exec(content)) !== null) {
    const userId = match[1];
    if (userId && !result.byId.includes(userId)) {
      result.byId.push(userId);
    }
  }

  // Parse mentions by name (@Tên Người Dùng)
  MENTION_REGEX.BY_NAME.lastIndex = 0; // Reset regex
  while ((match = MENTION_REGEX.BY_NAME.exec(content)) !== null) {
    const name = match[1].trim();
    if (name && !result.byName.includes(name)) {
      result.byName.push(name);
    }
  }

  return result;
}

/**
 * Tìm users được mention và trả về thông tin đầy đủ
 * @param {string} content - Nội dung chứa mentions
 * @returns {Promise<Array>} - Array of user objects { _id, email, fullname, avatarUrl }
 */
async function resolveMentions(content) {
  const parsed = parseMentions(content);
  const mentionedUsers = [];
  const foundIds = new Set();

  // Tìm users theo ID
  if (parsed.byId.length > 0) {
    try {
      const usersById = await User.find({
        _id: { $in: parsed.byId },
        active: true,
        disabled: { $ne: true }
      }).select('_id email fullname avatarUrl');

      usersById.forEach(user => {
        if (!foundIds.has(user._id.toString())) {
          foundIds.add(user._id.toString());
          mentionedUsers.push(user);
        }
      });
    } catch (err) {
      console.error('[MentionUtils] Error finding users by ID:', err.message);
    }
  }

  // Tìm users theo tên
  if (parsed.byName.length > 0) {
    for (const name of parsed.byName) {
      try {
        // Tìm chính xác hoặc gần đúng
        const user = await User.findOne({
          fullname: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') },
          active: true,
          disabled: { $ne: true }
        }).select('_id email fullname avatarUrl');

        if (user && !foundIds.has(user._id.toString())) {
          foundIds.add(user._id.toString());
          mentionedUsers.push(user);
        }
      } catch (err) {
        console.error(`[MentionUtils] Error finding user by name "${name}":`, err.message);
      }
    }
  }

  return mentionedUsers;
}

/**
 * Search users cho mention dropdown
 * Hỗ trợ search nhiều từ: "Hai Linh" sẽ tìm người có cả "Hai" VÀ "Linh"
 * 
 * @param {string} query - Search query (sau @)
 * @param {Object} options - { limit, excludeIds, department }
 * @returns {Promise<Array>} - Array of user suggestions
 */
async function searchUsersForMention(query, options = {}) {
  const { limit = 10, excludeIds = [], department = null } = options;

  if (!query || query.trim().length < 1) {
    return [];
  }

  const searchTerm = query.trim();
  
  // Tách thành nhiều từ để tìm kiếm
  const searchWords = searchTerm.split(/\s+/).filter(w => w.length > 0);
  
  // Build filter
  const filter = {
    active: true,
    disabled: { $ne: true }
  };

  // Loại trừ một số user IDs nếu cần
  if (excludeIds.length > 0) {
    filter._id = { $nin: excludeIds };
  }

  // Filter theo department nếu có
  if (department) {
    filter.department = department;
  }

  try {
    let orConditions = [];
    
    if (searchWords.length === 1) {
      // Search 1 từ: tìm như cũ
      const word = searchWords[0];
      orConditions = [
        // Tìm bắt đầu bằng query
        { fullname: { $regex: new RegExp(`^${escapeRegex(word)}`, 'i') } },
        // Tìm chứa query ở bất kỳ đâu
        { fullname: { $regex: new RegExp(escapeRegex(word), 'i') } },
        // Tìm theo email
        { email: { $regex: new RegExp(escapeRegex(word), 'i') } }
      ];
    } else {
      // Search nhiều từ: tất cả từ phải xuất hiện trong fullname
      // Ví dụ: "Hai Linh" → phải có cả "Hai" VÀ "Linh"
      const andConditions = searchWords.map(word => ({
        fullname: { $regex: new RegExp(escapeRegex(word), 'i') }
      }));
      
      orConditions = [
        // Tìm chứa TẤT CẢ các từ
        { $and: andConditions },
        // Backup: tìm nguyên cụm (exact phrase)
        { fullname: { $regex: new RegExp(escapeRegex(searchTerm), 'i') } }
      ];
    }

    const users = await User.find({
      ...filter,
      $or: orConditions
    })
      .select('_id fullname email avatarUrl department jobTitle')
      .limit(limit * 3) // Lấy nhiều hơn để sort sau
      .lean();

    // Sort results: ưu tiên match tốt nhất
    const sortedUsers = users.sort((a, b) => {
      const aFullname = (a.fullname || '').toLowerCase();
      const bFullname = (b.fullname || '').toLowerCase();
      const searchLower = searchTerm.toLowerCase();
      
      // Ưu tiên 1: Match nguyên cụm từ
      const aExactMatch = aFullname.includes(searchLower);
      const bExactMatch = bFullname.includes(searchLower);
      if (aExactMatch && !bExactMatch) return -1;
      if (!aExactMatch && bExactMatch) return 1;
      
      // Ưu tiên 2: Bắt đầu bằng từ đầu tiên
      const firstWord = searchWords[0].toLowerCase();
      const aStartsWith = aFullname.startsWith(firstWord);
      const bStartsWith = bFullname.startsWith(firstWord);
      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      
      // Ưu tiên 3: Số từ match nhiều hơn (cho multi-word search)
      if (searchWords.length > 1) {
        const aMatchCount = searchWords.filter(w => 
          aFullname.includes(w.toLowerCase())
        ).length;
        const bMatchCount = searchWords.filter(w => 
          bFullname.includes(w.toLowerCase())
        ).length;
        if (aMatchCount !== bMatchCount) {
          return bMatchCount - aMatchCount; // Nhiều match hơn lên trước
        }
      }
      
      // Ưu tiên 4: Tên ngắn hơn
      return aFullname.length - bFullname.length;
    });

    // Loại bỏ duplicates và giới hạn kết quả
    const uniqueUsers = [];
    const seenIds = new Set();
    
    for (const user of sortedUsers) {
      if (!seenIds.has(user._id.toString()) && uniqueUsers.length < limit) {
        seenIds.add(user._id.toString());
        uniqueUsers.push({
          _id: user._id,
          fullname: user.fullname,
          email: user.email,
          avatarUrl: user.avatarUrl,
          department: user.department,
          jobTitle: user.jobTitle
        });
      }
    }

    return uniqueUsers;
  } catch (err) {
    console.error('[MentionUtils] Search error:', err.message);
    return [];
  }
}

/**
 * Format mention text cho hiển thị
 * Thay @[userId] thành @Tên Người Dùng
 * @param {string} content - Nội dung gốc
 * @returns {Promise<string>} - Nội dung đã format
 */
async function formatMentionsForDisplay(content) {
  if (!content) return content;

  const parsed = parseMentions(content);
  let formattedContent = content;

  // Thay thế @[userId] thành @Tên
  if (parsed.byId.length > 0) {
    try {
      const users = await User.find({
        _id: { $in: parsed.byId }
      }).select('_id fullname').lean();

      const userMap = new Map(users.map(u => [u._id.toString(), u.fullname]));

      formattedContent = formattedContent.replace(MENTION_REGEX.BY_ID, (match, userId) => {
        const fullname = userMap.get(userId);
        return fullname ? `@${fullname}` : match;
      });
    } catch (err) {
      console.error('[MentionUtils] Format display error:', err.message);
    }
  }

  return formattedContent;
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tạo mention string từ user object
 * @param {Object} user - User object { _id, fullname }
 * @returns {string} - @[userId] format
 */
function createMentionString(user) {
  if (!user || !user._id) return '';
  return `@[${user._id}]`;
}

/**
 * Lấy tất cả user IDs được mention trong content
 * @param {string} content 
 * @returns {Promise<string[]>} - Array of user IDs
 */
async function getMentionedUserIds(content) {
  const users = await resolveMentions(content);
  return users.map(u => u._id.toString());
}

/**
 * Lấy emails của users được mention
 * @param {string} content 
 * @returns {Promise<string[]>} - Array of emails
 */
async function getMentionedUserEmails(content) {
  const users = await resolveMentions(content);
  return users.map(u => u.email).filter(Boolean);
}

module.exports = {
  // Constants
  MENTION_REGEX,
  
  // Parse functions
  parseMentions,
  resolveMentions,
  getMentionedUserIds,
  getMentionedUserEmails,
  
  // Search
  searchUsersForMention,
  
  // Format
  formatMentionsForDisplay,
  createMentionString,
  
  // Helper
  escapeRegex
};

