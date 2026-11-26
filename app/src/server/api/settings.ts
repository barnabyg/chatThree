import { Hono } from 'hono';
import { z } from 'zod';
import {
  ILLUSTRATION_MODES,
  IMAGE_STYLES,
  REASONING_EFFORTS,
  TEXT_BACKENDS,
} from '../../shared/api.ts';
import { isWellFormedApiKey } from '../apiKey.ts';
import { koboldCppAddress } from '../chat/koboldcpp.ts';
import {
  MAX_ILLUSTRATION_COOLDOWN,
  MAX_REPLY_LENGTH_WORDS,
  MIN_ILLUSTRATION_COOLDOWN,
  MIN_REPLY_LENGTH_WORDS,
  type SettingsStore,
} from '../settings.ts';
import { readBody } from './errors.ts';
import { ADDRESS_FORMAT } from './koboldcpp.ts';

const MIN_TOKEN_BUDGET = 100;
const MAX_TOKEN_BUDGET = 1_000_000;

const reasoningEffort = z
  .enum(
    REASONING_EFFORTS,
    `The thinking level must be one of ${REASONING_EFFORTS.map((effort) => `"${effort}"`).join(', ')}.`,
  )
  .nullable()
  .optional();

const update = z.strictObject({
  textBackend: z
    .enum(TEXT_BACKENDS, 'The text backend must be "openai" or "koboldcpp".')
    .optional(),
  koboldcppAddress: z
    .string()
    .max(500, 'The KoboldCpp address is too long.')
    .transform((text, context) => {
      const address = koboldCppAddress(text);
      if (address === undefined) {
        context.addIssue({ code: 'custom', message: ADDRESS_FORMAT });
        return z.NEVER;
      }
      return address;
    })
    .optional(),
  model: z
    .string()
    .trim()
    .min(1, 'The model name cannot be empty.')
    .max(200, 'The model name is too long.')
    .optional(),
  reasoningEffort,
  sceneModel: z
    .string()
    .trim()
    .min(1, 'The scene model name cannot be empty.')
    .max(200, 'The scene model name is too long.')
    .optional(),
  sceneReasoningEffort: reasoningEffort,
  illustrationMode: z
    .enum(
      ILLUSTRATION_MODES,
      'The illustration mode must be "off", "scene-changes", "key-moments" or "every-reply".',
    )
    .optional(),
  illustrationCooldown: z
    .int('The cooldown must be a whole number of replies.')
    .min(
      MIN_ILLUSTRATION_COOLDOWN,
      `The cooldown must be at least ${String(MIN_ILLUSTRATION_COOLDOWN)} reply.`,
    )
    .max(
      MAX_ILLUSTRATION_COOLDOWN,
      `The cooldown can be at most ${String(MAX_ILLUSTRATION_COOLDOWN)} replies.`,
    )
    .optional(),
  imageStyle: z
    .enum(
      IMAGE_STYLES,
      'The image style must be "realistic" or "illustration".',
    )
    .optional(),
  contextTokenBudget: z
    .int('The conversation budget must be a whole number of tokens.')
    .min(
      MIN_TOKEN_BUDGET,
      `The conversation budget must be at least ${String(MIN_TOKEN_BUDGET)} tokens.`,
    )
    .max(
      MAX_TOKEN_BUDGET,
      `The conversation budget can be at most ${String(MAX_TOKEN_BUDGET)} tokens.`,
    )
    .optional(),
  replyLengthWords: z
    .int('The suggested reply length must be a whole number of words.')
    .min(
      MIN_REPLY_LENGTH_WORDS,
      `The suggested reply length must be at least ${String(MIN_REPLY_LENGTH_WORDS)} words.`,
    )
    .max(
      MAX_REPLY_LENGTH_WORDS,
      `The suggested reply length can be at most ${String(MAX_REPLY_LENGTH_WORDS)} words.`,
    )
    .nullable()
    .optional(),
  speechMuted: z
    .boolean('Whether replies are spoken must be true or false.')
    .optional(),
  speechScope: z
    .enum(
      ['dialogue', 'everything'],
      'What is spoken must be "dialogue" or "everything".',
    )
    .optional(),
  apiKey: z
    .string()
    .trim()
    .min(1, 'The API key cannot be empty.')
    .max(500, 'The API key is too long.')
    .refine(
      isWellFormedApiKey,
      'An API key cannot contain spaces, line breaks or other special characters.',
    )
    .nullable()
    .optional(),
});

/**
 * Settings as the browser may see them. The API key is write-only.
 * `onSaved` is called after each change is saved.
 */
export function settingsRoutes(
  settings: SettingsStore,
  onSaved: () => void = () => undefined,
): Hono {
  const routes = new Hono();

  routes.get('/', (c) => c.json(settings.view()));

  routes.put('/', async (c) => {
    const {
      textBackend,
      koboldcppAddress: address,
      model,
      reasoningEffort: effort,
      sceneModel,
      sceneReasoningEffort,
      illustrationMode,
      illustrationCooldown,
      imageStyle,
      contextTokenBudget,
      replyLengthWords,
      speechMuted,
      speechScope,
      apiKey,
    } = await readBody(c, update);
    const saved = settings.update({
      ...(textBackend !== undefined && { textBackend }),
      ...(address !== undefined && { koboldcppAddress: address }),
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { reasoningEffort: effort }),
      ...(sceneModel !== undefined && { sceneModel }),
      ...(sceneReasoningEffort !== undefined && { sceneReasoningEffort }),
      ...(illustrationMode !== undefined && { illustrationMode }),
      ...(illustrationCooldown !== undefined && { illustrationCooldown }),
      ...(imageStyle !== undefined && { imageStyle }),
      ...(contextTokenBudget !== undefined && { contextTokenBudget }),
      ...(replyLengthWords !== undefined && { replyLengthWords }),
      ...(speechMuted !== undefined && { speechMuted }),
      ...(speechScope !== undefined && { speechScope }),
      ...(apiKey !== undefined && { apiKey }),
    });
    onSaved();
    return c.json(saved);
  });

  return routes;
}
