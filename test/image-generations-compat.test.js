const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildResponsesImageEditBody,
  buildResponsesImageGenerationBody,
  extractImageGenerationResponse,
  parseMultipartFormData,
} = require('../app/image-generations-compat');

test('buildResponsesImageGenerationBody maps image generation payloads to Responses image tool calls', () => {
  assert.deepEqual(
    buildResponsesImageGenerationBody({
      model: 'gpt-image-1.5',
      prompt: 'Draw a small red hat.',
      output_format: 'webp',
    }, {
      model: 'gpt-5.5',
    }),
    {
      model: 'gpt-5.5',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Draw a small red hat.',
            },
          ],
        },
      ],
      tools: [
        {
          type: 'image_generation',
          output_format: 'webp',
        },
      ],
      store: false,
    },
  );
});

test('buildResponsesImageGenerationBody rejects missing prompts', () => {
  assert.throws(() => {
    buildResponsesImageGenerationBody({
      model: 'gpt-image-1.5',
    });
  }, /prompt 必须是非空字符串/);
});

test('buildResponsesImageGenerationBody rejects multi image requests', () => {
  assert.throws(() => {
    buildResponsesImageGenerationBody({
      prompt: 'Draw a small red hat.',
      n: 2,
    });
  }, /当前 token 兼容路径仅支持 n=1/);
});

test('extractImageGenerationResponse converts Responses SSE image output to Images JSON', () => {
  const sse = [
    'event: response.output_item.done',
    `data: ${JSON.stringify({
      type: 'response.output_item.done',
      item: {
        type: 'image_generation_call',
        id: 'ig_123',
        status: 'completed',
        result: Buffer.from('png-data').toString('base64'),
        revised_prompt: 'A small red hat.',
      },
    })}`,
    '',
  ].join('\n');

  assert.deepEqual(
    extractImageGenerationResponse(sse),
    {
      created: 0,
      data: [
        {
          b64_json: Buffer.from('png-data').toString('base64'),
          revised_prompt: 'A small red hat.',
        },
      ],
    },
  );
});

test('extractImageGenerationResponse converts completed Responses JSON output to Images JSON', () => {
  const body = JSON.stringify({
    output: [
      {
        type: 'image_generation_call',
        result: 'Zm9v',
      },
    ],
  });

  assert.deepEqual(
    extractImageGenerationResponse(body, {
      created: 123,
    }),
    {
      created: 123,
      data: [
        {
          b64_json: 'Zm9v',
        },
      ],
    },
  );
});

test('parseMultipartFormData extracts text fields and image files', () => {
  const boundary = 'airouter-boundary';
  const body = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="prompt"',
    '',
    'Add a star.',
    `--${boundary}`,
    'Content-Disposition: form-data; name="image"; filename="input.png"',
    'Content-Type: image/png',
    '',
    'PNGDATA',
    `--${boundary}--`,
    '',
  ].join('\r\n'));

  const form = parseMultipartFormData(body, `multipart/form-data; boundary=${boundary}`);

  assert.deepEqual(form.fields, {
    prompt: 'Add a star.',
  });
  assert.equal(form.files.length, 1);
  assert.equal(form.files[0].name, 'image');
  assert.equal(form.files[0].filename, 'input.png');
  assert.equal(form.files[0].contentType, 'image/png');
  assert.equal(form.files[0].data.toString('utf8'), 'PNGDATA');
});

test('buildResponsesImageEditBody maps image edit forms to Responses image tool calls', () => {
  const body = buildResponsesImageEditBody({
    fields: {
      prompt: 'Add a star.',
      output_format: 'png',
    },
    files: [
      {
        name: 'image',
        contentType: 'image/png',
        data: Buffer.from('PNGDATA'),
      },
    ],
  }, {
    model: 'gpt-5.5',
  });

  assert.deepEqual(body, {
    model: 'gpt-5.5',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Add a star.',
          },
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`,
          },
        ],
      },
    ],
    tools: [
      {
        type: 'image_generation',
        output_format: 'png',
      },
    ],
    store: false,
  });
});
