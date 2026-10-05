export function normalizeConversationSearchQuery(name: string): string {
  // 名册与聊天列表可能使用不同的空格字符；仅统一空白，保留花体昵称等字形。
  return name.replace(/\s+/g, ' ').trim()
}
