const axios = require('axios');
const UserAgent = require('user-agents');
const pino = require('pino');
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const { sleep } = require("@/lib/utils");
const GoogleSheetService = require('./GoogleSheetService.js'); 
const sheetService = new GoogleSheetService();
let activeSunoLicense = null;

const logger = pino();
const DEFAULT_MODEL = "chirp-v3-5";

class SunoApi {
  static BASE_URL = "https://studio-api.suno.ai";
  static CLERK_BASE_URL = "https://clerk.suno.com";
  static JSDELIVR_BASE_URL = "https://data.jsdelivr.com";

  constructor() {
    this.client = undefined;
    this.clerkVersion = undefined;
    this.sid = undefined;
    this.currentToken = undefined;
  }

  setupBindings() {
    this.generate = this.licenseCheckDecorator(this.generate);
    this.concatenate = this.licenseCheckDecorator(this.concatenate);
    this.custom_generate = this.licenseCheckDecorator(this.custom_generate);
    this.generateLyrics = this.licenseCheckDecorator(this.generateLyrics);
    this.extendAudio = this.licenseCheckDecorator(this.extendAudio);
  }

  async init(cookie) {
    this.setupBindings();

    const cookieJar = new CookieJar();
    const randomUserAgent = new UserAgent(/Chrome/).random().toString();

    const client = wrapper(
      axios.create({
        jar: cookieJar,
        withCredentials: true,
        headers: {
          "User-Agent": randomUserAgent,
          Cookie: cookie,
        },
      })
    );

    client.interceptors.request.use((config) => {
      if (this.currentToken) {
        config.headers["Authorization"] = `Bearer ${this.currentToken}`;
      }
      return config;
    });

    this.client = client;
    await this.getClerkLatestVersion();
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  async getClerkLatestVersion() {
    const getClerkVersionUrl = `${SunoApi.JSDELIVR_BASE_URL}/v1/package/npm/@clerk/clerk-js`;
    const versionListResponse = await this.client.get(getClerkVersionUrl);
    if (!versionListResponse?.data?.["tags"]["latest"]) {
      throw new Error("Failed to get clerk version info, Please try again later");
    }
    this.clerkVersion = versionListResponse?.data?.["tags"]["latest"];
  }

  async getAuthToken() {
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?_clerk_js_version=${this.clerkVersion}`;
    const sessionResponse = await this.client.get(getSessionUrl);
    if (!sessionResponse?.data?.response?.["last_active_session_id"]) {
      throw new Error("Failed to get session id, you may need to update the SUNO_COOKIE");
    }
    this.sid = sessionResponse.data.response["last_active_session_id"];
  }

  async keepAlive(isWait) {
    if (!this.sid) {
      throw new Error("Session ID is not set. Cannot renew token.");
    }
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?_clerk_js_version==${this.clerkVersion}`;
    const renewResponse = await this.client.post(renewUrl);
    logger.info("KeepAlive...\n");
    if (isWait) {
      await sleep(1, 2);
    }
    const newToken = renewResponse.data["jwt"];
    this.currentToken = newToken;
  }

  async generate(prompt, make_instrumental = false, model, wait_audio = false) {
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = this.generateSongs(
      prompt,
      false,
      undefined,
      undefined,
      make_instrumental,
      model,
      wait_audio
    );
    const costTime = Date.now() - startTime;
    logger.info("Generate Response:\n" + JSON.stringify(audios, null, 2));
    logger.info("Cost time: " + costTime);
    return audios;
  }

  async concatenate(clip_id) {
    await this.keepAlive(false);
    const payload = { clip_id: clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      {
        timeout: 10000,
      }
    );
    if (response.status !== 200) {
      throw new Error("Error response:" + response.statusText);
    }
    return response.data;
  }

  async custom_generate(prompt, tags, title, make_instrumental = false, model, wait_audio = false, negative_tags) {
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags
    );
    const costTime = Date.now() - startTime;
    logger.info("Cost time: " + costTime);
    return audios;
  }

  async generateSongs(prompt, isCustom, tags, title, make_instrumental, model, wait_audio = false, negative_tags) {
    await this.keepAlive(false);
    const payload = {
      make_instrumental: make_instrumental == true,
      mv: model || DEFAULT_MODEL,
      prompt: "",
    };
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.prompt = prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/v2/`,
      payload,
      {
        timeout: 10000,
      }
    );
    if (response.status !== 200) {
      throw new Error("Error response:" + response.statusText);
    }
    const songIds = response.data["clips"].map((audio) => audio.id);
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          (audio) => audio.status === "streaming" || audio.status === "complete"
        );
        const allError = response.every((audio) => audio.status === "error");
        if (allCompleted || allError) {
          return response;
        }
        lastResponse = response;
        await sleep(3, 6);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      await this.keepAlive(true);
      return response.data["clips"].map((audio) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration,
      }));
    }
  }

  async generateLyrics(prompt) {
    await this.keepAlive(false);
    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );
    while (lyricsResponse?.data?.status !== "complete") {
      await sleep(2);
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }

    return lyricsResponse.data;
  }

  async extendAudio(audioId, prompt = "", continueAt = "0", tags = "", title = "", model) {
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/v2/`,
      {
        continue_clip_id: audioId,
        continue_at: continueAt,
        mv: model || DEFAULT_MODEL,
        prompt: prompt,
        tags: tags,
        title: title,
      }
    );
    console.log("response：\n", response);
    return response.data;
  }

  parseLyrics(prompt) {
    const lines = prompt.split("\n").filter((line) => line.trim() !== "");
    return lines.join("\n");
  }

  async get(songIds) {
    await this.keepAlive(false);
    let url = `${SunoApi.BASE_URL}/api/feed/`;
    if (songIds) {
      url = `${url}?ids=${songIds.join(",")}`;
    }
    logger.info("Get audio status: " + url);
    const response = await this.client.get(url, {
      timeout: 3000,
    });

    const audios = response.data;
    return audios.map((audio) => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt
        ? this.parseLyrics(audio.metadata.prompt)
        : "",
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata.error_message,
    }));
  }

  async getClip(clipId) {
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/clip/${clipId}`
    );
    return response.data;
  }

  async get_credits(alive = false) {
    if (!alive) {
      await this.keepAlive(alive);
    }

    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/billing/info/`
    );

    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage,
    };
  }

  licenseCheckDecorator(method) {
    return async (...args) => {
      let credits = await this.get_credits();
      if (credits.credits_left < 10) {
        const licKeys = await sheetService.getSunoLicenseKeys();
        for (const lic of licKeys) {
          const new_Cookie = lic.licenseKey;
          sunoApi = await newSunoApi(new_Cookie);

          credits = await (await sunoApi).get_credits();
          if (credits.credits_left >= 10) {
            console.log(`licenseCheckDecorator:FOUND VALID LICENSE: ${lic.account}`);
            activeSunoLicense = lic;
            await sheetService.setSunoActiveLicense(lic.account, lic.licenseKey);

            return await (await sunoApi)[method.name](...args);
          } else {
            console.log(`licenseCheckDecorator:LICENSE NOT GOOD:${lic.account}`);
          }
        }

        console.log(`licenseCheckDecorator: NO LICENSE WAS GOOD. Calling original account.${activeSunoLicense.account}`);
        return method.apply(this, args);
      }

      return method.apply(this, args);
    };
  }
}

const newSunoApi = async (cookie) => {
  if (!cookie) {
    activeSunoLicense = await sheetService.getSunoActiveLicense();
    console.log("newSunoApi: activeLicense account:", activeSunoLicense.account);
    cookie = activeSunoLicense.licenseKey;
  }

  const sunoApi = new SunoApi();
  await sunoApi.init(cookie);

  return sunoApi;
};

export let sunoApi = newSunoApi('');