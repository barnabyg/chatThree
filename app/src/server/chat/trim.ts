// Keeping a long conversation within a token budget.
//
// The rule: send the newest messages that fit the budget and leave out the
// rest, oldest first. The newest message is always sent, even if it alone is
// over the budget, because a request with no conversation is useless.
//
// Token counts are estimates. The exact count depends on the model's
// tokeniser; about four characters per token is typical for English prose,
// and the budget is a soft limit on cost, not the model's hard limit.

const CHARACTERS_PER_TOKEN = 4;
/** Each message costs a few tokens beyond its text, for its role and framing. */
const TOKENS_PER_MESSAGE = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARACTERS_PER_TOKEN) + TOKENS_PER_MESSAGE;
}

/**
 * How many messages, counted from the oldest, are left out so that the rest
 * of `conversation` fits within `budget` tokens.
 */
export function countNotSent(
  conversation: readonly { content: string }[],
  budget: number,
): number {
  let used = 0;
  let firstSent = conversation.length;
  while (firstSent > 0) {
    const tokens = estimateTokens(conversation[firstSent - 1]?.content ?? '');
    const isNewest = firstSent === conversation.length;
    if (!isNewest && used + tokens > budget) break;
    used += tokens;
    firstSent -= 1;
  }
  return firstSent;
}
