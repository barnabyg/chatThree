// Making illustrations: a picture of one of the character's messages, from
// the character's reference picture and the reference picture of the place
// the story is in. The scene call describes the moment; the engine paints it.
// Work goes on in the background, and how far it has got is kept here for
// the chat's view to show.

import { randomInt } from 'node:crypto';
import type { IllustrationProgress } from '../../shared/api.ts';
import { ProviderError, type ChatProvider } from '../chat/provider.ts';
import {
  EngineFailedError,
  EngineRefusedError,
  EngineUnavailableError,
  type EngineJobs,
} from '../engine/jobs.ts';
import type { SettingsStore } from '../settings.ts';
import type { CharacterStore } from '../store/characters.ts';
import type { ChatStore } from '../store/chats.ts';
import type { MediaStore } from '../store/media.ts';
import type { SceneStore, StoredLocation } from '../store/scenes.ts';
import type { ScenarioStore } from '../store/scenarios.ts';
import {
  placePrompt,
  readScene,
  SceneAnswerError,
  scenePrompt,
  sceneRequest,
  startingPlace,
} from './describe.ts';

/** Landscape, as a scene is wider than it is tall. Multiples of 16, as the engine needs. */
export const SCENE_SIZE = { width: 1152, height: 768 };
/** Seeds are drawn from below this, as for characters' pictures. */
const MAX_SEED = 2 ** 31;

/** A request to illustrate that makes no sense for the chat as it stands. */
export class IllustrationRequestError extends Error {}

/** A message that is already being illustrated. */
export class IllustrationBusyError extends Error {
  constructor() {
    super('That message is already being illustrated.');
  }
}

/** Why an illustration failed, in words for the user. */
function describeFailure(error: unknown): string {
  if (
    error instanceof ProviderError ||
    error instanceof SceneAnswerError ||
    error instanceof IllustrationRequestError
  ) {
    return error.message;
  }
  if (error instanceof EngineUnavailableError) {
    return 'The picture cannot be made because the engine is not ready.';
  }
  if (error instanceof EngineRefusedError) {
    return `The engine refused to make the picture: ${error.message}`;
  }
  if (error instanceof EngineFailedError) {
    return 'The engine could not make the picture.';
  }
  console.error('Unexpected failure while illustrating:', error);
  return 'Something went wrong while making the picture.';
}

export interface IllustratorDependencies {
  chats: ChatStore;
  characters: CharacterStore;
  scenarios: ScenarioStore;
  scenes: SceneStore;
  settings: SettingsStore;
  provider: ChatProvider;
  jobs: EngineJobs;
  media: MediaStore;
}

export class Illustrator {
  readonly #chats: ChatStore;
  readonly #characters: CharacterStore;
  readonly #scenarios: ScenarioStore;
  readonly #scenes: SceneStore;
  readonly #settings: SettingsStore;
  readonly #provider: ChatProvider;
  readonly #jobs: EngineJobs;
  readonly #media: MediaStore;
  /** Per chat, the messages being illustrated or whose illustration failed. */
  readonly #progress = new Map<string, Map<number, IllustrationProgress>>();
  /** Places whose reference picture is being painted, so it is painted once. */
  readonly #paintingPlaces = new Map<number, Promise<string>>();

  constructor(dependencies: IllustratorDependencies) {
    this.#chats = dependencies.chats;
    this.#characters = dependencies.characters;
    this.#scenarios = dependencies.scenarios;
    this.#scenes = dependencies.scenes;
    this.#settings = dependencies.settings;
    this.#provider = dependencies.provider;
    this.#jobs = dependencies.jobs;
    this.#media = dependencies.media;
  }

  /** How far each illustration of the chat has got, oldest message first. */
  progress(chatId: string): IllustrationProgress[] {
    return [...(this.#progress.get(chatId)?.values() ?? [])].sort(
      (a, b) => a.messageId - b.messageId,
    );
  }

  /**
   * Start illustrating one of the character's messages. Returns at once;
   * `progress` follows the work. Throws `IllustrationRequestError` for a
   * message that cannot be illustrated, and `IllustrationBusyError` for one
   * that already is being.
   */
  illustrate(chatId: string, messageId: number): void {
    const message = this.#chats
      .messages(chatId)
      .find(({ id }) => id === messageId);
    if (message === undefined) {
      throw new IllustrationRequestError('That message is not in this chat.');
    }
    if (message.role !== 'assistant') {
      throw new IllustrationRequestError(
        "Only the character's messages can be illustrated.",
      );
    }
    this.#needPicture(chatId);
    const current = this.#progress.get(chatId)?.get(messageId);
    if (current !== undefined && current.state !== 'failed') {
      throw new IllustrationBusyError();
    }
    this.#set(chatId, { messageId, state: 'describing' });
    void this.#run(chatId, messageId);
  }

  /** Delete the files of pictures that nothing refers to any more. */
  prune(): void {
    const kept = this.#scenes.files();
    for (const folder of ['scenes', 'locations'] as const) {
      for (const file of this.#media.list(folder)) {
        if (!kept.has(file)) this.#media.remove(file);
      }
    }
  }

  /** The path of the chat's character's reference picture, or why there is none. */
  #needPicture(chatId: string): string {
    const chat = this.#chats.find(chatId);
    const file =
      chat === undefined
        ? undefined
        : this.#characters.imageFile(chat.character.id);
    if (chat === undefined || file === undefined) {
      const name = chat?.character.name ?? 'the character';
      throw new IllustrationRequestError(
        `Illustrating needs a reference picture of ${name}. Give ${name} a picture first.`,
      );
    }
    return this.#media.path(file);
  }

  #set(chatId: string, progress: IllustrationProgress): void {
    let chat = this.#progress.get(chatId);
    if (chat === undefined) {
      chat = new Map();
      this.#progress.set(chatId, chat);
    }
    chat.set(progress.messageId, progress);
  }

  #clear(chatId: string, messageId: number): void {
    const chat = this.#progress.get(chatId);
    chat?.delete(messageId);
    if (chat?.size === 0) this.#progress.delete(chatId);
  }

  async #run(chatId: string, messageId: number): Promise<void> {
    try {
      const chat = this.#chats.find(chatId);
      const character =
        chat === undefined
          ? undefined
          : this.#characters.find(chat.character.id);
      const scenario =
        chat === undefined ? undefined : this.#scenarios.find(chat.scenario.id);
      if (character === undefined || scenario === undefined) return;
      const messages = this.#chats.messages(chatId);
      const upTo = messages.findIndex(({ id }) => id === messageId);
      if (upTo === -1) return;
      const location = this.#scenes.currentLocation(
        chatId,
        startingPlace(scenario),
      );

      const picture = readScene(
        await this.#provider.structured({
          model: this.#settings.sceneModel(),
          ...sceneRequest({
            character,
            scenario,
            messages: messages.slice(0, upTo + 1),
            place: location,
          }),
        }),
      );

      if (location.imageFile === undefined) {
        this.#set(chatId, { messageId, state: 'painting-location' });
      }
      const placeFile = await this.#placePicture(location);

      this.#set(chatId, { messageId, state: 'painting' });
      const scene = await this.#jobs.paint({
        prompt: scenePrompt(character.name, location, picture),
        ...SCENE_SIZE,
        seed: randomInt(MAX_SEED),
        references: [this.#needPicture(chatId), this.#media.path(placeFile)],
      });
      const file = this.#media.save('scenes', 'png', scene);
      // The message may have been deleted or regenerated while it was painted.
      if (
        this.#scenes.addIllustration(chatId, messageId, location.id, file) ===
        undefined
      ) {
        this.#media.remove(file);
      }
      this.#clear(chatId, messageId);
    } catch (error) {
      this.#set(chatId, {
        messageId,
        state: 'failed',
        error: describeFailure(error),
      });
    }
  }

  /** The file of the place's reference picture, painting it first if it has none. */
  async #placePicture(location: StoredLocation): Promise<string> {
    if (location.imageFile !== undefined) return location.imageFile;
    const painting =
      this.#paintingPlaces.get(location.id) ??
      this.#paintPlace(location).finally(() => {
        this.#paintingPlaces.delete(location.id);
      });
    this.#paintingPlaces.set(location.id, painting);
    return painting;
  }

  /** Paint the place's reference picture, in place of any it has. */
  async #paintPlace(location: StoredLocation): Promise<string> {
    const picture = await this.#jobs.paint({
      prompt: placePrompt(location),
      ...SCENE_SIZE,
      seed: randomInt(MAX_SEED),
    });
    const file = this.#media.save('locations', 'png', picture);
    const old = this.#scenes.setLocationImage(location.id, file);
    if (old === false) {
      this.#media.remove(file);
      throw new IllustrationRequestError(
        'That place is no longer in the chat.',
      );
    }
    if (old !== undefined) this.#media.remove(old);
    return file;
  }
}
