// Making illustrations: a picture of one of the character's messages, from
// the character's reference picture and the reference picture of the place
// the story is in. The scene call describes the moment; the engine paints it.
// Work goes on in the background, and how far it has got is kept here for
// the chat's view to show. After each reply the scene call also runs by
// itself, to follow the story and, as the illustration mode says, to
// illustrate the reply without being asked.

import { randomInt } from 'node:crypto';
import type { IllustrationProgress } from '../../shared/api.ts';
import {
  ProviderError,
  type ChatProvider,
  withEffort,
} from '../chat/provider.ts';
import { engineFailureMessage, NOT_PAINTED } from '../api/engineFailures.ts';
import type { EngineJobs } from '../engine/jobs.ts';
import type { SettingsStore } from '../settings.ts';
import type { CharacterStore } from '../store/characters.ts';
import type { ChatStore } from '../store/chats.ts';
import type { MediaStore } from '../store/media.ts';
import type { SceneStore, StoredLocation } from '../store/scenes.ts';
import type { ScenarioStore } from '../store/scenarios.ts';
import {
  type Place,
  placePrompt,
  readScene,
  type ScenePicture,
  SceneAnswerError,
  scenePrompt,
  sceneRequest,
  startingPlace,
} from './describe.ts';
import { nextPlace, type PlaceReport, shouldIllustrate } from './state.ts';

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
  const engine = engineFailureMessage(error, NOT_PAINTED);
  if (engine !== undefined) return engine;
  console.error('Unexpected failure while illustrating:', error);
  return 'Something went wrong while making the picture.';
}

/** What the illustrator works with. */
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

/** A moment the scene call has described, ready to paint. */
interface Described {
  characterName: string;
  picture: ScenePicture;
  /** Where it is painted. */
  location: StoredLocation;
  /** Whether the moment took the story somewhere else. */
  moved: boolean;
  /** Whether the scene call said the moment is worth a picture. */
  worthIt: boolean;
}

/** A picture waiting for its turn on the engine. */
interface PaintJob {
  chatId: string;
  messageId: number;
  /** Asked for by the app after a reply, not by the user. */
  automatic: boolean;
  described: Described;
}

/**
 * Makes chats' illustrations, by hand and after replies, and keeps track of
 * how far each has got.
 */
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
  /**
   * Pictures waiting to be painted, oldest first. One is painted at a time,
   * as the engine paints one at a time, so that a waiting picture can still
   * be replaced by a newer one.
   */
  readonly #queue: PaintJob[] = [];
  #painting = false;
  /** Per chat, how many scene calls after a reply are under way. */
  readonly #following = new Map<string, number>();

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

  /** Whether the scene call is reading the chat's latest reply. */
  isFollowing(chatId: string): boolean {
    return this.#following.has(chatId);
  }

  /**
   * Start illustrating one of the character's messages, as the user asked.
   * Returns at once; `progress` follows the work. Throws
   * `IllustrationRequestError` for a message that cannot be illustrated,
   * and `IllustrationBusyError` for one that already is being.
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
    // A picture asked for restarts the wait before the next automatic one.
    this.#scenes.markIllustrated(chatId);
    this.#set(chatId, { messageId, state: 'describing' });
    void this.#describeThenPaint(chatId, messageId);
  }

  /**
   * After each reply: have the scene call follow the story, and illustrate
   * the reply if the illustration mode says to (never, in Off). Nothing that goes wrong
   * here reaches the reply: a failed scene call is logged and the reply is
   * not illustrated.
   */
  afterReply(chatId: string, messageId: number): void {
    this.#following.set(chatId, (this.#following.get(chatId) ?? 0) + 1);
    void this.#followReply(chatId, messageId).finally(() => {
      const left = (this.#following.get(chatId) ?? 1) - 1;
      if (left === 0) this.#following.delete(chatId);
      else this.#following.set(chatId, left);
    });
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

  /**
   * Paint a new reference picture of one of the chat's places, in place of
   * any it has. Resolves once it is saved.
   */
  async repaintPlace(chatId: string, locationId: number): Promise<void> {
    const location = this.#scenes.location(chatId, locationId);
    if (location === undefined) {
      throw new IllustrationRequestError('That place is not in this chat.');
    }
    // In turn after one already being painted, so the newest is kept.
    const before = this.#paintingPlaces.get(locationId);
    await this.#trackPlace(
      locationId,
      before === undefined
        ? this.#paintPlace(location)
        : before.catch(() => undefined).then(() => this.#paintPlace(location)),
    );
  }

  /**
   * Remember that a place's picture is being painted, until it is done, so
   * that whatever needs it next waits for it rather than painting another.
   */
  #trackPlace(locationId: number, painting: Promise<string>): Promise<string> {
    this.#paintingPlaces.set(locationId, painting);
    const forget = (): void => {
      if (this.#paintingPlaces.get(locationId) === painting) {
        this.#paintingPlaces.delete(locationId);
      }
    };
    painting.then(forget, forget);
    return painting;
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

  #fail(chatId: string, messageId: number, error: unknown): void {
    this.#set(chatId, {
      messageId,
      state: 'failed',
      error: describeFailure(error),
    });
  }

  async #describeThenPaint(chatId: string, messageId: number): Promise<void> {
    try {
      const described = await this.#describe(chatId, messageId);
      if (described === undefined) {
        this.#clear(chatId, messageId);
        return;
      }
      this.#enqueue({ chatId, messageId, automatic: false, described });
    } catch (error) {
      this.#fail(chatId, messageId, error);
    }
  }

  async #followReply(chatId: string, messageId: number): Promise<void> {
    let described: Described | undefined;
    try {
      described = await this.#describe(chatId, messageId);
    } catch (error) {
      console.error(
        `The scene call after a reply failed, so the reply was not illustrated: ${describeFailure(error)}`,
      );
      return;
    }
    if (described === undefined) return;
    const chat = this.#chats.find(chatId);
    const illustrate = shouldIllustrate(
      this.#settings.illustrationMode(),
      this.#settings.illustrationCooldown(),
      {
        moved: described.moved,
        worthIt: described.worthIt,
        repliesSinceImage: this.#scenes.repliesSinceIllustration(chatId),
      },
    );
    // A character without a reference picture cannot be illustrated; the
    // Illustrate button says so when it is asked.
    if (
      !illustrate ||
      chat === undefined ||
      this.#characters.imageFile(chat.character.id) === undefined ||
      this.#progress.get(chatId)?.has(messageId) === true
    ) {
      return;
    }
    this.#scenes.markIllustrated(chatId);
    this.#enqueue({ chatId, messageId, automatic: true, described });
  }

  /**
   * Have the scene call describe a message, and follow the story to the
   * place it reports. `undefined` if the message or the chat has gone.
   */
  async #describe(
    chatId: string,
    messageId: number,
  ): Promise<Described | undefined> {
    const chat = this.#chats.find(chatId);
    const character =
      chat === undefined ? undefined : this.#characters.find(chat.character.id);
    const scenario =
      chat === undefined ? undefined : this.#scenarios.find(chat.scenario.id);
    if (character === undefined || scenario === undefined) return undefined;
    const messages = this.#chats.messages(chatId);
    const upTo = messages.findIndex(({ id }) => id === messageId);
    if (upTo === -1) return undefined;
    const start = startingPlace(scenario);
    const before = this.#scenes.currentLocation(chatId, start);

    const { picture, place, worthIt } = readScene(
      await this.#provider.structured({
        model: this.#settings.sceneModel(),
        ...withEffort(this.#settings.sceneReasoningEffort()),
        ...sceneRequest({
          character,
          scenario,
          messages: messages.slice(0, upTo + 1),
          place: before,
          places: this.#scenes.locations(chatId),
        }),
      }),
    );
    // Only the latest of the character's messages says where the story is
    // now; an earlier one is pictured where it took place.
    const latest =
      this.#chats.messages(chatId).findLast(({ role }) => role === 'assistant')
        ?.id === messageId;
    const { location, moved } = this.#follow(
      chatId,
      start,
      place,
      latest ? messageId : undefined,
    );
    return {
      characterName: character.name,
      picture,
      location,
      moved,
      worthIt,
    };
  }

  /**
   * The place a scene call's report puts the scene in, recorded among the
   * chat's places if it is new, and whether that is a move. With `mover`,
   * that message took the chat's story there.
   */
  #follow(
    chatId: string,
    start: Place,
    report: PlaceReport,
    mover: number | undefined,
  ): { location: StoredLocation; moved: boolean } {
    // Read again: the story may have moved while the scene was described.
    const current = this.#scenes.currentLocation(chatId, start);
    const next = nextPlace(current, this.#scenes.locations(chatId), report);
    const location =
      next.kind === 'stay'
        ? current
        : next.kind === 'return'
          ? (this.#scenes.location(chatId, next.id) ?? current)
          : this.#scenes.addLocation(chatId, next);
    if (mover !== undefined && location.id !== current.id) {
      this.#scenes.moveTo(chatId, mover, location.id);
    }
    return { location, moved: location.id !== current.id };
  }

  /**
   * Put a picture in line to be painted. A chat has at most one automatic
   * picture waiting: a newer one takes the place of one not yet started.
   */
  #enqueue(job: PaintJob): void {
    if (job.automatic) {
      const waiting = this.#queue.findIndex(
        (queued) => queued.automatic && queued.chatId === job.chatId,
      );
      if (waiting !== -1) {
        const [replaced] = this.#queue.splice(waiting, 1);
        if (replaced !== undefined) {
          this.#clear(replaced.chatId, replaced.messageId);
        }
      }
    }
    this.#set(job.chatId, { messageId: job.messageId, state: 'waiting' });
    this.#queue.push(job);
    void this.#drain();
  }

  /** Paint the waiting pictures, one at a time, until there are none. */
  async #drain(): Promise<void> {
    if (this.#painting) return;
    this.#painting = true;
    try {
      for (let job = this.#queue.shift(); job; job = this.#queue.shift()) {
        await this.#paint(job);
      }
    } finally {
      this.#painting = false;
    }
  }

  async #paint({ chatId, messageId, described }: PaintJob): Promise<void> {
    const { characterName, picture, location } = described;
    try {
      // The message may have been deleted or regenerated while it waited.
      if (!this.#chats.messages(chatId).some(({ id }) => id === messageId)) {
        this.#clear(chatId, messageId);
        return;
      }
      const placeFile = await this.#placePicture(chatId, messageId, location);
      this.#set(chatId, { messageId, state: 'painting' });
      const scene = await this.#jobs.paint({
        prompt: scenePrompt(
          characterName,
          location,
          picture,
          this.#settings.imageStyle(),
        ),
        ...SCENE_SIZE,
        seed: randomInt(MAX_SEED),
        references: [this.#needPicture(chatId), this.#media.path(placeFile)],
      });
      const file = this.#media.save('scenes', 'png', scene);
      // The message may have gone while it was painted.
      if (!this.#scenes.addIllustration(chatId, messageId, location.id, file)) {
        this.#media.remove(file);
      }
      this.#clear(chatId, messageId);
    } catch (error) {
      this.#fail(chatId, messageId, error);
    }
  }

  /** The file of the place's reference picture, painting it first if it has none. */
  async #placePicture(
    chatId: string,
    messageId: number,
    location: StoredLocation,
  ): Promise<string> {
    const saved = this.#scenes.location(chatId, location.id)?.imageFile;
    if (saved !== undefined) return saved;
    this.#set(chatId, { messageId, state: 'painting-location' });
    return (
      this.#paintingPlaces.get(location.id) ??
      this.#trackPlace(location.id, this.#paintPlace(location))
    );
  }

  /** Paint the place's reference picture, in place of any it has. */
  async #paintPlace(location: StoredLocation): Promise<string> {
    const picture = await this.#jobs.paint({
      prompt: placePrompt(location, this.#settings.imageStyle()),
      ...SCENE_SIZE,
      seed: randomInt(MAX_SEED),
    });
    const file = this.#media.save('locations', 'png', picture);
    const saved = this.#scenes.setLocationImage(location.id, file);
    if (saved === undefined) {
      this.#media.remove(file);
      throw new IllustrationRequestError(
        'That place is no longer in the chat.',
      );
    }
    if (saved.replaced !== undefined) this.#media.remove(saved.replaced);
    return file;
  }
}
