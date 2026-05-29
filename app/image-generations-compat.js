// Token 图片接口兼容路径通过 Codex Responses + image_generation 工具实现。
// Codex 源码里的 Responses 模型目录来自：
// /Users/lrd/code/jscode/codex/codex-rs/models-manager/models.json
// 当前目录列出的模型是：gpt-5.5、gpt-5.4、gpt-5.4-mini、
// gpt-5.3-codex、gpt-5.2、codex-auto-review。账号后端是否真的给某个
// Responses 模型开启 image_generation，仍以运行时为准。
// Codex 源码里的图片 API fallback 说明来自：
// /Users/lrd/code/jscode/codex/codex-rs/skills/src/assets/samples/imagegen/references/image-api.md
// 其中列出的 GPT Image 模型是：gpt-image-2、gpt-image-1.5、
// gpt-image-1、gpt-image-1-mini。为了兼容 OpenAI Images 客户端，请求里
// 仍然可以带这些图片模型名；但 token 路径真正发给上游的是下面这个
// Responses 模型，默认值可用 AIROUTER_IMAGE_GENERATION_RESPONSES_MODEL 覆盖。
const DEFAULT_RESPONSES_IMAGE_MODEL = 'gpt-5.5';
const SUPPORTED_OUTPUT_FORMATS = new Set(['png', 'jpeg', 'webp']);

function normalizeOutputFormat(value) {
  const outputFormat = typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : 'png';

  if (!SUPPORTED_OUTPUT_FORMATS.has(outputFormat)) {
    throw new Error('output_format 仅支持 png、jpeg 或 webp');
  }

  return outputFormat;
}

function normalizeImageCount(value) {
  if (typeof value === 'undefined' || value === null) {
    return 1;
  }

  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('n 必须是正整数');
  }

  return count;
}

function buildResponsesImageGenerationBody(payload, options = {}) {
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    throw new Error('prompt 必须是非空字符串');
  }

  const count = normalizeImageCount(payload.n);
  if (count !== 1) {
    throw new Error('当前 token 兼容路径仅支持 n=1');
  }

  return {
    model: options.model || DEFAULT_RESPONSES_IMAGE_MODEL,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt,
          },
        ],
      },
    ],
    tools: [
      {
        type: 'image_generation',
        output_format: normalizeOutputFormat(payload.output_format),
      },
    ],
    store: false,
  };
}

function parseContentDisposition(value) {
  const parts = String(value || '').split(';').map(part => part.trim());
  const parsed = {};

  for (const part of parts.slice(1)) {
    const [key, rawValue] = part.split('=');
    if (!key || typeof rawValue === 'undefined') {
      continue;
    }

    parsed[key.trim().toLowerCase()] = rawValue.trim().replace(/^"|"$/g, '');
  }

  return parsed;
}

function parseMultipartBoundary(contentType) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2]).trim() : '';
}

function parseMultipartFormData(body, contentType) {
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) {
    throw new Error('multipart/form-data 缺少 boundary');
  }

  const fields = {};
  const files = [];
  const bodyText = Buffer.isBuffer(body) ? body.toString('binary') : String(body || '');
  const delimiter = `--${boundary}`;

  for (const rawPart of bodyText.split(delimiter)) {
    if (!rawPart || rawPart === '--' || rawPart === '--\r\n') {
      continue;
    }

    let part = rawPart;
    if (part.startsWith('\r\n')) {
      part = part.slice(2);
    }

    if (part.endsWith('\r\n')) {
      part = part.slice(0, -2);
    }

    if (part.endsWith('--')) {
      part = part.slice(0, -2);
    }

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      continue;
    }

    const headerText = part.slice(0, headerEnd);
    const dataText = part.slice(headerEnd + 4);
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const separator = line.indexOf(':');
      if (separator < 0) {
        continue;
      }

      headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }

    const disposition = parseContentDisposition(headers['content-disposition']);
    if (!disposition.name) {
      continue;
    }

    const data = Buffer.from(dataText, 'binary');
    if (disposition.filename) {
      files.push({
        name: disposition.name,
        filename: disposition.filename,
        contentType: headers['content-type'] || 'application/octet-stream',
        data,
      });
    } else {
      fields[disposition.name] = data.toString('utf8');
    }
  }

  return {
    fields,
    files,
  };
}

function buildResponsesImageEditBody(form, options = {}) {
  const prompt = typeof form?.fields?.prompt === 'string' ? form.fields.prompt.trim() : '';
  if (!prompt) {
    throw new Error('prompt 必须是非空字符串');
  }

  const count = normalizeImageCount(form.fields.n);
  if (count !== 1) {
    throw new Error('当前 token 兼容路径仅支持 n=1');
  }

  const images = (Array.isArray(form.files) ? form.files : [])
    .filter(file => file.name === 'image' && Buffer.isBuffer(file.data) && file.data.length > 0);
  if (!images.length) {
    throw new Error('image 文件不能为空');
  }

  return {
    model: options.model || DEFAULT_RESPONSES_IMAGE_MODEL,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: prompt,
          },
          ...images.map(file => ({
            type: 'input_image',
            image_url: `data:${file.contentType || 'application/octet-stream'};base64,${file.data.toString('base64')}`,
          })),
        ],
      },
    ],
    tools: [
      {
        type: 'image_generation',
        output_format: normalizeOutputFormat(form.fields.output_format),
      },
    ],
    store: false,
  };
}

function parseSsePayloads(bodyText) {
  const events = [];
  const blocks = String(bodyText || '')
    .replace(/\r\n/g, '\n')
    .split('\n\n');

  for (const block of blocks) {
    if (!block.trim()) {
      continue;
    }

    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    const dataText = dataLines.join('\n');
    if (!dataText || dataText === '[DONE]') {
      continue;
    }

    events.push(JSON.parse(dataText));
  }

  return events;
}

function collectImageGenerationItems(payloads) {
  const items = [];

  for (const payload of payloads) {
    if (payload?.item?.type === 'image_generation_call') {
      items.push(payload.item);
    }

    if (payload?.type === 'image_generation_call') {
      items.push(payload);
    }

    const output = Array.isArray(payload?.response?.output)
      ? payload.response.output
      : Array.isArray(payload?.output)
        ? payload.output
        : [];

    for (const item of output) {
      if (item?.type === 'image_generation_call') {
        items.push(item);
      }
    }
  }

  return items;
}

function parseResponsesPayloads(bodyText) {
  const text = String(bodyText || '').trim();
  if (!text) {
    return [];
  }

  if (text.startsWith('event:') || text.includes('\nevent:')) {
    return parseSsePayloads(text);
  }

  return [JSON.parse(text)];
}

function extractImageGenerationResponse(bodyText, options = {}) {
  const payloads = parseResponsesPayloads(bodyText);
  const imageItems = collectImageGenerationItems(payloads)
    .filter(item => typeof item.result === 'string' && item.result);

  if (!imageItems.length) {
    throw new Error('Responses 返回中没有 image_generation_call 结果');
  }

  return {
    created: Number.isInteger(options.created) ? options.created : 0,
    data: imageItems.slice(-1).map(item => {
      const output = {
        b64_json: item.result,
      };

      if (typeof item.revised_prompt === 'string' && item.revised_prompt) {
        output.revised_prompt = item.revised_prompt;
      }

      return output;
    }),
  };
}

module.exports = {
  buildResponsesImageEditBody,
  buildResponsesImageGenerationBody,
  extractImageGenerationResponse,
  parseMultipartFormData,
};
