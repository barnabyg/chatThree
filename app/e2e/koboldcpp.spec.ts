import {
  FAKE_KOBOLDCPP_MODEL,
  KOBOLD_SCENE,
  type KoboldBehaviour,
} from '../test-support/fake-koboldcpp.ts';
import { expect, test } from './fixtures.ts';
import {
  engineReady,
  giveMaraAPicture,
  messages,
  openEmptyChat,
  openLighthouseChat,
  send,
} from './helpers.ts';

test('with KoboldCpp as the text backend, the connection is tested and replies come from it, spoken as they arrive', async ({
  page,
  app,
  openai,
  kobold,
}) => {
  kobold.respondWith({
    kind: 'reply',
    reasoning: ['The traveller wants', ' shelter.'],
    chunks: ['"Come in.', ' Sit by the stove."'],
  });
  await page.goto('/#/settings/connection');
  await page.getByLabel('Text backend').selectOption({ label: 'KoboldCpp' });

  // The OpenAI fields give way to KoboldCpp's.
  await expect(page.getByLabel('OpenAI API key')).toHaveCount(0);
  await expect(page.getByLabel('Thinking level')).toHaveCount(0);
  // How much is sent follows the model's context length instead.
  await expect(page.getByLabel('Conversation budget (tokens)')).toHaveCount(0);
  await page.getByLabel('Server address').fill(kobold.address);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status').getByText(/^Connected/)).toHaveText(
    `Connected. ${FAKE_KOBOLDCPP_MODEL} is loaded, with a context of 8,192 tokens.`,
  );
  await expect(page.getByLabel('Loaded model')).toHaveValue(
    FAKE_KOBOLDCPP_MODEL,
  );
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('status').getByText('Settings saved.'),
  ).toBeVisible();

  // The scene model is not KoboldCpp's to choose either.
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'Images' })
    .click();
  await expect(page.getByLabel('Scene model')).toHaveCount(0);

  // The choice survives a reload, and the loaded model is shown.
  await page.goto('/#/settings/connection');
  await expect(page.getByLabel('Text backend')).toHaveValue('koboldcpp');
  await expect(page.getByLabel('Loaded model')).toHaveValue(
    FAKE_KOBOLDCPP_MODEL,
  );

  await openEmptyChat(page);
  await engineReady(page);
  await send(page, 'Hello? Is anyone there?');

  await expect(messages(page)).toHaveText([
    /Hello\? Is anyone there\?/,
    /Mara Quill\s*"Come in\. Sit by the stove\."/,
  ]);
  await expect
    .poll(() => app.spoken())
    .toEqual(['Come in.', 'Sit by the stove.']);
  expect(kobold.requests).toHaveLength(1);
  expect(openai.requests).toHaveLength(0);
});

test('a KoboldCpp that cannot be reached is named in the error', async ({
  page,
  kobold,
}) => {
  const address = kobold.address;
  await kobold.close();
  await page.goto('/#/settings/connection');
  await page.getByLabel('Text backend').selectOption({ label: 'KoboldCpp' });
  await page.getByLabel('Server address').fill(address);

  await page.getByRole('button', { name: 'Test connection' }).click();

  await expect(page.getByRole('alert')).toContainText(
    `Could not reach KoboldCpp at ${address}`,
  );
});

test('with KoboldCpp as the text backend, a message is illustrated from its description of the scene', async ({
  page,
  app,
  openai,
  kobold,
}) => {
  const saved = await page.request.put('/api/settings', {
    data: { textBackend: 'koboldcpp', koboldcppAddress: kobold.address },
  });
  expect(saved.ok()).toBe(true);
  kobold.answerWith({
    kind: 'text',
    text: `\`\`\`json\n${JSON.stringify({ ...KOBOLD_SCENE, action: 'Mara lights the great lamp.' })}\n\`\`\``,
  });
  await giveMaraAPicture(page);
  await openLighthouseChat(page);
  await engineReady(page);

  const opening = messages(page).first();
  await opening.getByRole('button', { name: 'Illustrate' }).click();

  await expect(
    opening.getByRole('img', { name: 'Illustration 1 of this moment' }),
  ).toBeVisible();
  expect(kobold.structuredRequests).toHaveLength(1);
  expect(openai.structuredRequests).toHaveLength(0);
  const scenes = (await app.engineJobs()).filter(
    (job) => job.path === '/image',
  );
  expect(scenes.at(-1)?.body.prompt).toContain('Mara lights the great lamp.');
});

const THINKING_REPLIES: [string, KoboldBehaviour][] = [
  [
    'sent apart, as KoboldCpp does',
    {
      kind: 'reply',
      reasoning: ['The traveller', ' is cold. "Go away."'],
      chunks: ['\n\n"Come in.', ' Sit by the stove."'],
      holdAfter: 0,
    },
  ],
  [
    'between tags in the reply',
    {
      kind: 'reply',
      chunks: [
        '<think>The traveller',
        ' is cold. "Go away."</think>',
        '\n\n"Come in.',
        ' Sit by the stove."',
      ],
      holdAfter: 2,
    },
  ],
];

for (const [how, reply] of THINKING_REPLIES) {
  test(`a thinking model's thoughts ${how} are never shown, saved or spoken, and Thinking… shows while it thinks`, async ({
    page,
    app,
    kobold,
  }) => {
    const saved = await page.request.put('/api/settings', {
      data: { textBackend: 'koboldcpp', koboldcppAddress: kobold.address },
    });
    expect(saved.ok()).toBe(true);
    kobold.load('koboldcpp/Qwen3.8-27B-Uncensored-Q4_K_M');
    kobold.respondWith(reply);
    await openEmptyChat(page);
    await engineReady(page);
    await send(page, 'Hello? Is anyone there?');

    await expect(messages(page).last()).toHaveText(/Mara Quill\s*Thinking…/);
    kobold.release();

    await expect(messages(page)).toHaveText([
      /Hello\? Is anyone there\?/,
      /^Mara Quill\s*"Come in\. Sit by the stove\."(Illustrate)?$/,
    ]);
    await expect
      .poll(() => app.spoken())
      .toEqual(['Come in.', 'Sit by the stove.']);
    await page.reload();
    await expect(messages(page).last()).toHaveText(
      /^Mara Quill\s*"Come in\. Sit by the stove\."(Illustrate)?$/,
    );
  });
}

test('closing the app during a reply from KoboldCpp stops KoboldCpp generating', async ({
  page,
  app,
  kobold,
}) => {
  const saved = await page.request.put('/api/settings', {
    data: { textBackend: 'koboldcpp', koboldcppAddress: kobold.address },
  });
  expect(saved.ok()).toBe(true);
  kobold.respondWith({
    kind: 'reply',
    chunks: ['"Come in.', ' Sit by the stove."'],
    holdAfter: 1,
  });
  await openEmptyChat(page);
  await send(page, 'Hello? Is anyone there?');
  await expect(messages(page).last()).toContainText('Come in.');

  await app.stop();

  // Once more if the scene call after the stopped reply was running.
  expect(kobold.aborts).toBeGreaterThanOrEqual(1);
  expect(kobold.requests[0]?.abandoned).toBe(true);
});

test("the loaded model's profile is edited under Settings > Text, and the next reply uses it", async ({
  page,
  kobold,
}) => {
  const saved = await page.request.put('/api/settings', {
    data: { textBackend: 'koboldcpp', koboldcppAddress: kobold.address },
  });
  expect(saved.ok()).toBe(true);
  await page.goto('/#/settings/text');

  await expect(page.getByTestId('profile-model')).toHaveText(
    FAKE_KOBOLDCPP_MODEL,
  );
  await expect(page.getByLabel('Preset')).toHaveValue('');
  await expect(page.getByLabel('Temperature', { exact: true })).toHaveValue(
    '1',
  );

  // A value out of range is refused at its field.
  await page.getByLabel('Temperature', { exact: true }).fill('9');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(
    page.getByText('Temperature must be from 0 to 5.'),
  ).toBeVisible();

  await page.getByLabel('Temperature', { exact: true }).fill('0.4');
  await expect(
    page.getByRole('button', { name: 'Reset Temperature', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Stop sequence 1', { exact: true }).fill('###');
  await page.getByLabel('Extra request fields (JSON)').fill('{"top_a":');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText(/^This is not valid JSON/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Reset Extra request fields (JSON)' })
    .click();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(
    page
      .getByRole('status')
      .getByText('Profile saved. It applies from the next reply.'),
  ).toBeVisible();

  // Saved: it survives a reload, marked as changed.
  await page.reload();
  await expect(page.getByLabel('Temperature', { exact: true })).toHaveValue(
    '0.4',
  );
  await expect(
    page.getByRole('button', { name: 'Reset Temperature', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset Top K' })).toHaveCount(
    0,
  );

  await openEmptyChat(page);
  await send(page, 'Hello? Is anyone there?');
  await expect(messages(page)).toHaveCount(2);
  expect(kobold.requests.at(-1)?.body).toMatchObject({
    temperature: 0.4,
    stop: ['###'],
  });

  // Reset all goes back to the preset.
  await page.goto('/#/settings/text');
  await page.getByRole('button', { name: 'Reset all' }).click();
  await expect(page.getByLabel('Temperature', { exact: true })).toHaveValue(
    '1',
  );
  await expect(
    page.getByRole('button', { name: 'Reset Temperature', exact: true }),
  ).toHaveCount(0);
});
