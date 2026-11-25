// The "How to reply" part of a chat's instructions. The user can write
// reply prompts of their own; a chat without one uses DEFAULT_REPLY_PROMPT.
// Both the server, which sends it, and the UI, which shows it, read this.

/** Stands for the character's name in a reply prompt. */
export const CHARACTER_PLACEHOLDER = '{character}';
/** Stands for the player's name, or "the user" with no player. */
export const USER_PLACEHOLDER = '{user}';

/** The reply prompt of a chat that has none of its own. */
export const DEFAULT_REPLY_PROMPT = `Reply only as ${CHARACTER_PLACEHOLDER}, in character, with what ${CHARACTER_PLACEHOLDER} says and does next. Never speak or act for the user, and never step outside the story.`;

/** `prompt` with its placeholders filled in. */
export function fillReplyPrompt(
  prompt: string,
  characterName: string,
  playerName: string | undefined,
): string {
  const user = (playerName ?? '').trim() || 'the user';
  // Replaced by functions, so a `$` in a name is not read as a pattern.
  return prompt
    .replaceAll(CHARACTER_PLACEHOLDER, () => characterName)
    .replaceAll(USER_PLACEHOLDER, () => user);
}
