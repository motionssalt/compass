// Only the Telegram API surface we actually touch. Everything is
// optional-ish because Telegram nests things heavily.

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
}

// Inline-keyboard callback query. Users tap a button; Telegram POSTs
// this to us. We must answerCallbackQuery within a few seconds so the
// client stops showing the loading spinner on the button.
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  chat_instance?: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// ---------------------------------------------------------------
// Inline-keyboard shapes (send / edit message)
// ---------------------------------------------------------------
//
// Kept minimal — we only build InlineKeyboardMarkup with `text` +
// `callback_data` buttons (no URL / login buttons / etc.). Telegram
// enforces `callback_data` <= 64 bytes; encoders in
// src/handlers/menuUi.ts are responsible for staying under that.

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}
