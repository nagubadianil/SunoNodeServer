import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { sleep } from "@/lib/utils";

const logger = pino();
export const DEFAULT_MODEL = "chirp-v3-5";


export interface AudioInfo {
  id: string; // Unique identifier for the audio
  title?: string; // Title of the audio
  image_url?: string; // URL of the image associated with the audio
  lyric?: string; // Lyrics of the audio
  audio_url?: string; // URL of the audio file
  video_url?: string; // URL of the video associated with the audio
  created_at: string; // Date and time when the audio was created
  model_name: string; // Name of the model used for audio generation
  gpt_description_prompt?: string; // Prompt for GPT description
  prompt?: string; // Prompt for audio generation 
  status: string; // Status
  type?: string;
  tags?: string; // Genre of music.
  negative_tags?: string; // Negative tags of music.
  duration?: string; // Duration of the audio
  error_message?: string; // Error message if any
}

class SunoApi {
  private static BASE_URL: string = 'https://studio-api.suno.ai';
  private static CLERK_BASE_URL: string = 'https://clerk.suno.com';
  private static JSDELIVR_BASE_URL: string = 'https://data.jsdelivr.com';

  private client?: AxiosInstance;
  private clerkVersion?: string;
  private sid?: string;
  private currentToken?: string;

  public async init(cookie: string): Promise<SunoApi> {
    console.log("init() beg")
    console.log("SunoApi init: cookie:", cookie.substring(0,20) + "...")


    const cookieJar = new CookieJar();
    const randomUserAgent = new UserAgent(/Chrome/).random().toString();

    console.log("init: before create axios wrapper")
    const client = wrapper(axios.create({
      jar: cookieJar,
      withCredentials: true,
      headers: {
        'User-Agent': randomUserAgent,
        'Cookie': cookie
      }
    }))
    console.log("init: before interceptors")
    client.interceptors.request.use((config) => {
      if (this.currentToken) { // Use the current token status
        config.headers['Authorization'] = `Bearer ${this.currentToken}`;
      }
      return config;
    });

    this.client = client
    console.log("init: before getClerkLatestVersion and code")
    await this.getClerkLatestVersion();
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  /**
   * Get the clerk package latest version id.
   */
  private async getClerkLatestVersion() {
    // URL to get clerk version ID
    const getClerkVersionUrl = `${SunoApi.JSDELIVR_BASE_URL}/v1/package/npm/@clerk/clerk-js`; 
    // Get clerk version ID
    const versionListResponse = await this.client.get(getClerkVersionUrl);
    if (!versionListResponse?.data?.['tags']['latest']) {
      throw new Error("Failed to get clerk version info, Please try again later");
    }
    // Save clerk version ID for auth
    this.clerkVersion = versionListResponse?.data?.['tags']['latest'];
  }

  /**
   * Get the session ID and save it for later use.
   */
  private async getAuthToken() {
    // URL to get session ID
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?_clerk_js_version=${this.clerkVersion}`; 
    // Get session ID
    const sessionResponse = await this.client.get(getSessionUrl);
    if (!sessionResponse?.data?.response?.['last_active_session_id']) {
      throw new Error("Failed to get session id, you may need to update the SUNO_COOKIE");
    }
    // Save session ID for later use
    this.sid = sessionResponse.data.response['last_active_session_id'];
  }

  /**
   * Keep the session alive.
   * @param isWait Indicates if the method should wait for the session to be fully renewed before returning.
   */
  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error("Session ID is not set. Cannot renew token.");
    }
    // URL to renew session token
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?_clerk_js_version==${this.clerkVersion}`; 
    // Renew session token
    const renewResponse = await this.client.post(renewUrl);
    logger.info("KeepAlive...\n");
    if (isWait) {
      await sleep(1, 2);
    }
    const newToken = renewResponse.data['jwt'];
    // Update Authorization field in request header with the new JWT token
    this.currentToken = newToken;
  }

  /**
   * Generate a song based on the prompt.
   * @param prompt The text prompt to generate audio from.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @returns 
   */
  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,

  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = this.generateSongs(prompt, false, undefined, undefined, make_instrumental, model, wait_audio);
    const costTime = Date.now() - startTime;
    logger.info("Generate Response:\n" + JSON.stringify(audios, null, 2));
    logger.info("Cost time: " + costTime);
    return audios;
  }

  /**
   * Calls the concatenate endpoint for a clip to generate the whole song.
   * @param clip_id The ID of the audio clip to concatenate.
   * @returns A promise that resolves to an AudioInfo object representing the concatenated audio.
   * @throws Error if the response status is not 200.
   */
  public async concatenate(clip_id: string): Promise<AudioInfo> {
    await this.keepAlive(false);
    const payload: any = { clip_id: clip_id };

    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      payload,
      {
        timeout: 10000, // 10 seconds timeout
      },
    );
    if (response.status !== 200) {
      throw new Error("Error response:" + response.statusText);
    }
    return response.data;
  }

  /**
   * Generates custom audio based on provided parameters.
   *
   * @param prompt The text prompt to generate audio from.
   * @param tags Tags to categorize the generated audio.
   * @param title The title for the generated audio.
   * @param make_instrumental Indicates if the generated audio should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated audios.
   */
public async custom_generate(
  prompt: string,
  tags: string,
  title: string,
  make_instrumental: boolean = false,
  model?: string,
  wait_audio: boolean = false,
  negative_tags?: string,
): Promise<AudioInfo[]> {
  const startTime = Date.now();
  const audios = await this.generateSongs(prompt, true, tags, title, make_instrumental, model, wait_audio, negative_tags);
  const costTime = Date.now() - startTime;
  logger.info("Custom Generate Response:\n" + JSON.stringify(audios, null, 2));
  logger.info("Cost time: " + costTime);
  return audios;
}

  /**
   * Generates songs based on the provided parameters.
   *
   * @param prompt The text prompt to generate songs from.
   * @param isCustom Indicates if the generation should consider custom parameters like tags and title.
   * @param tags Optional tags to categorize the song, used only if isCustom is true.
   * @param title Optional title for the song, used only if isCustom is true.
   * @param make_instrumental Indicates if the generated song should be instrumental.
   * @param wait_audio Indicates if the method should wait for the audio file to be fully generated before returning.
   * @param negative_tags Negative tags that should not be included in the generated audio.
   * @returns A promise that resolves to an array of AudioInfo objects representing the generated songs.
   */
  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    const payload: any = {
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
    logger.info("generateSongs payload:\n" + JSON.stringify({
      prompt: prompt,
      isCustom: isCustom,
      tags: tags,
      title: title,
      make_instrumental: make_instrumental,
      wait_audio: wait_audio,
      negative_tags: negative_tags,
      payload: payload,
    }, null, 2));
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/v2/`,
      payload,
      {
        timeout: 10000, // 10 seconds timeout
      },
    );
    logger.info("generateSongs Response:\n" + JSON.stringify(response.data, null, 2));
    if (response.status !== 200) {
      throw new Error("Error response:" + response.statusText);
    }
    const songIds = response.data['clips'].map((audio: any) => audio.id);
    //Want to wait for music file generation
    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(5, 5);
      while (Date.now() - startTime < 100000) {
        const response = await this.get(songIds);
        const allCompleted = response.every(
          audio => audio.status === 'streaming' || audio.status === 'complete'
        );
        const allError = response.every(
          audio => audio.status === 'error'
        );
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
      return response.data['clips'].map((audio: any) => ({
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

  /**
   * Generates lyrics based on a given prompt.
   * @param prompt The prompt for generating lyrics.
   * @returns The generated lyrics text.
   */
  public async generateLyrics(prompt: string): Promise<string> {
    await this.keepAlive(false);
    // Initiate lyrics generation
    const generateResponse = await this.client.post(`${SunoApi.BASE_URL}/api/generate/lyrics/`, { prompt });
    const generateId = generateResponse.data.id;

    // Poll for lyrics completion
    let lyricsResponse = await this.client.get(`${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`);
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(2); // Wait for 2 seconds before polling again
      lyricsResponse = await this.client.get(`${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`);
    }

    // Return the generated lyrics text
    return lyricsResponse.data;
  }

  /**
   * Extends an existing audio clip by generating additional content based on the provided prompt.
   * 
   * @param audioId The ID of the audio clip to extend.
   * @param prompt The prompt for generating additional content.
   * @param continueAt Extend a new clip from a song at mm:ss(e.g. 00:30). Default extends from the end of the song.
   * @param tags Style of Music.
   * @param title Title of the song.
   * @returns A promise that resolves to an AudioInfo object representing the extended audio clip.
   */
  public async extendAudio(
    audioId: string,
    prompt: string = "",
    continueAt: string = "0",
    tags: string = "",
    title: string = "",
    model?: string,
  ): Promise<AudioInfo> {
    const response = await this.client.post(`${SunoApi.BASE_URL}/api/generate/v2/`, {
      continue_clip_id: audioId,
      continue_at: continueAt,
      mv: model || DEFAULT_MODEL,
      prompt: prompt,
      tags: tags,
      title: title
    });
    console.log("response：\n", response);
    return response.data;
  }

  /**
   * Processes the lyrics (prompt) from the audio metadata into a more readable format.
   * @param prompt The original lyrics text.
   * @returns The processed lyrics text.
   */
  private parseLyrics(prompt: string): string {
    // Assuming the original lyrics are separated by a specific delimiter (e.g., newline), we can convert it into a more readable format.
    // The implementation here can be adjusted according to the actual lyrics format.
    // For example, if the lyrics exist as continuous text, it might be necessary to split them based on specific markers (such as periods, commas, etc.).
    // The following implementation assumes that the lyrics are already separated by newlines.

    // Split the lyrics using newline and ensure to remove empty lines.
    const lines = prompt.split('\n').filter(line => line.trim() !== '');

    // Reassemble the processed lyrics lines into a single string, separated by newlines between each line.
    // Additional formatting logic can be added here, such as adding specific markers or handling special lines.
    return lines.join('\n');
  }

  /**
   * Retrieves audio information for the given song IDs.
   * @param songIds An optional array of song IDs to retrieve information for.
   * @returns A promise that resolves to an array of AudioInfo objects.
   */
  public async get(songIds?: string[]): Promise<AudioInfo[]> {

    return await this.change_Account(async (context)=>{
     
      await context.keepAlive(false);
      let url = `${SunoApi.BASE_URL}/api/feed/`;
      if (songIds) {
        url = `${url}?ids=${songIds.join(',')}`;
      }
      logger.info("Get audio status: " + url);
      const response = await context.client.get(url, {
        // 3 seconds timeout
        timeout: 3000
      });
  
      const audios = response.data;
      return audios.map((audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt ? this.parseLyrics(audio.metadata.prompt) : "",
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

    })
    
  }

  /**
   * Retrieves information for a specific audio clip.
   * @param clipId The ID of the audio clip to retrieve information for.
   * @returns A promise that resolves to an object containing the audio clip information.
   */
  public async getClip(clipId: string): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/clip/${clipId}`);
    return response.data;
  }

  public async get_credits(alive=false): Promise<object> {
    if(!alive){
      await this.keepAlive(alive);
    }
    console.log("get_credits: before calling client.get")
    
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/billing/info/`);
    
    console.log("get_credits: response.total_credits_left:", JSON.stringify(response.data.total_credits_left,null,2))
    
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage,
    };
  }

  private async change_Account(apiCall){
    const credits = await this.get_credits()
    console.log("change_Account: credits:", JSON.stringify(credits,null,2))

    if(credits.credits_left < 44){
      console.log("credits < 44")

      const new_Cookie = "__cf_bm=Pnar9zZp8l7qYXTKxeiwBZVSePm7Ir8uQV6.J8.fJs4-1730061365-1.0.1.1-fIdD4izPybDzN2RpiaVwVCObXdy4d9perDW0QWtCtymceISI4GsVuNPyjWYSk_R7Ud.zRW3vYit8GgJKXYiPtQ; _cfuvid=sjkVVvRoN9KELPNuXoEViSa9HNkL4ttXbaMPmUe5fDk-1730061365693-0.0.1.1-604800000; _ga=GA1.1.2065282642.1730061367; ajs_anonymous_id=0824b3a7-a26d-49f3-9407-fbc22ff4362a; __client=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNsaWVudF8ybzJJaG80UzE0QmtHTFFZMUdTdDBhaklNUTgiLCJyb3RhdGluZ190b2tlbiI6IndnaXJtdjl4c2Noa3R5b290aDBqZmpid2gycWY1a3ltemNnOTAwejkifQ.t9jkwnLO69LYCOVaxiVlOobNPQbLFgz91wT3sVDOa4YopYkW3yrnveBxmOAjtkJanGFIe6OCYllaTzbXdtHOhlAgHA5sGDjd4K92lWsSNiSWw3ABGhMDBXonWe67jc7RKqG2bl4QUU4WGOi98YJjEAGJEOV9iwign1I4VtzR0UX9YiIHqbbqIG1KZmuSOpOh-g0Mmtt6Lc5BJCbcjeJTzQminYxJqlpu6FafAPwDmng303D4_kFh-mJ9HuuJtv-PTMN6COdQMvUrrnef_lk5MECsZDjQaFi8SDZmOR8OXNjocSOQE0wbZDehV-mr8WBMMbfAlnbUY6LrF1ZXXIRhxw; __client_uat=1730061381; __client_uat_U9tcbTPE=1730061381; mp_26ced217328f4737497bd6ba6641ca1c_mixpanel=%7B%22distinct_id%22%3A%20%229490581d-a1d2-4ebf-9355-e68bd65e8233%22%2C%22%24device_id%22%3A%20%22192cfb1734b530-00add237568357-26011951-1fa400-192cfb1734c530%22%2C%22%24initial_referrer%22%3A%20%22%24direct%22%2C%22%24initial_referring_domain%22%3A%20%22%24direct%22%2C%22__mps%22%3A%20%7B%7D%2C%22__mpso%22%3A%20%7B%7D%2C%22__mpus%22%3A%20%7B%7D%2C%22__mpa%22%3A%20%7B%7D%2C%22__mpu%22%3A%20%7B%7D%2C%22__mpr%22%3A%20%5B%5D%2C%22__mpap%22%3A%20%5B%5D%2C%22%24search_engine%22%3A%20%22google%22%2C%22%24user_id%22%3A%20%229490581d-a1d2-4ebf-9355-e68bd65e8233%22%7D; _ga_7B0KEDD7XP=GS1.1.1730061366.1.1.1730061574.0.0.0"
     
      const sunoApi = new SunoApi();
      console.log("Initing new instance with new cookie")
      await sunoApi.init(new_Cookie);

      console.log("Calling get_credits for test")
      
      const credits2 = await sunoApi.get_credits()
      console.log("New credits: credits2:", JSON.stringify(credits2, null, 2))
      
      console.log("Calling the original API Method with new Instance, which was passed in as callback")
      return await apiCall(sunoApi)
    }
    console.log("Calling the original API Method with this")
    return await apiCall(this)
  }
}
const SUNO_COOKIE = "_ga=GA1.1.1626675578.1729871786; ajs_anonymous_id=3ee71d7a-dc13-42b4-b395-8befe50b5903; __client=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNsaWVudF8ybnc2UnFUYkVNdWRPY3Q2VWNPS1JNRko4eWYiLCJyb3RhdGluZ190b2tlbiI6ImhodmFxNzhwcTc0d252dDlvOTJ6a2hmYW9vdWZ4Mmcwdzdlcmc3M2IifQ.WncUJPhLsEExF7M8jiGNGiuDiQl6xLt_Uckdcr_AiVoK8vcs-FfAXZez5kqfOSlJs6tV4pSGZO2TXPSRgzm-QqGQ4rnFtsQe1K9xo79Gk-JP-vIYVFssJORdd0s6Y2FeyjhBNHZrubbWrjfxeZhU-hr3hafiOeYvG_Rfq66goKLpTnJJXeqlekV2znvpq5FQ2Bp62vEfr6tGK41hh5VE6FEztmRI6nY1eGZreqwwAH8wEiEMBa0jxl5GU0T2XrRcnWztnMZ-ZlXY-TkczjcTb1h_z98fXag5CQT6P21bjVLzfaNl2URD5ZBQK0XhehjWezkVANP4fHA_eaZNHYuaRg; __client_uat=1729871819; __client_uat_U9tcbTPE=1729871819; __cf_bm=8oTHkQvc6qc1bfYHm.7MB5J6r8R4NB6wAtRDvmLqxC8-1730039954-1.0.1.1-Il1EeGjb5kDD0OnC5HLhbbVY9Jsm9v85ZF3M8esPiR8RXIsSUhuOwu.yJFX9P86dvGj4KUmEjViDs7dHVvWIlA; _cfuvid=dAW6IerIycNU.w63W_279Abs2AbdjSa30_Iq3ra5Rfw-1730039954405-0.0.1.1-604800000; mp_26ced217328f4737497bd6ba6641ca1c_mixpanel=%7B%22distinct_id%22%3A%20%22b09ff6ce-a3ab-47ab-b492-7363bbeceb2e%22%2C%22%24device_id%22%3A%20%22192c464ae8b4ea-07a53bf4810987-26001051-144000-192c464ae8b4ea%22%2C%22%24initial_referrer%22%3A%20%22%24direct%22%2C%22%24initial_referring_domain%22%3A%20%22%24direct%22%2C%22__mps%22%3A%20%7B%7D%2C%22__mpso%22%3A%20%7B%7D%2C%22__mpus%22%3A%20%7B%7D%2C%22__mpa%22%3A%20%7B%7D%2C%22__mpu%22%3A%20%7B%7D%2C%22__mpr%22%3A%20%5B%5D%2C%22__mpap%22%3A%20%5B%5D%2C%22%24search_engine%22%3A%20%22google%22%2C%22%24user_id%22%3A%20%22b09ff6ce-a3ab-47ab-b492-7363bbeceb2e%22%7D; __stripe_mid=7bc31dd6-dc02-44d4-a020-86e3410b0c7f5912ff; __stripe_sid=1257a204-4217-43bd-ae36-b6b8da5c27611d895a; _ga_7B0KEDD7XP=GS1.1.1730039956.6.1.1730040088.0.0.0"
//const SUNO_COOKIE = "__cf_bm=Pnar9zZp8l7qYXTKxeiwBZVSePm7Ir8uQV6.J8.fJs4-1730061365-1.0.1.1-fIdD4izPybDzN2RpiaVwVCObXdy4d9perDW0QWtCtymceISI4GsVuNPyjWYSk_R7Ud.zRW3vYit8GgJKXYiPtQ; _cfuvid=sjkVVvRoN9KELPNuXoEViSa9HNkL4ttXbaMPmUe5fDk-1730061365693-0.0.1.1-604800000; _ga=GA1.1.2065282642.1730061367; ajs_anonymous_id=0824b3a7-a26d-49f3-9407-fbc22ff4362a; __client=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNsaWVudF8ybzJJaG80UzE0QmtHTFFZMUdTdDBhaklNUTgiLCJyb3RhdGluZ190b2tlbiI6IndnaXJtdjl4c2Noa3R5b290aDBqZmpid2gycWY1a3ltemNnOTAwejkifQ.t9jkwnLO69LYCOVaxiVlOobNPQbLFgz91wT3sVDOa4YopYkW3yrnveBxmOAjtkJanGFIe6OCYllaTzbXdtHOhlAgHA5sGDjd4K92lWsSNiSWw3ABGhMDBXonWe67jc7RKqG2bl4QUU4WGOi98YJjEAGJEOV9iwign1I4VtzR0UX9YiIHqbbqIG1KZmuSOpOh-g0Mmtt6Lc5BJCbcjeJTzQminYxJqlpu6FafAPwDmng303D4_kFh-mJ9HuuJtv-PTMN6COdQMvUrrnef_lk5MECsZDjQaFi8SDZmOR8OXNjocSOQE0wbZDehV-mr8WBMMbfAlnbUY6LrF1ZXXIRhxw; __client_uat=1730061381; __client_uat_U9tcbTPE=1730061381; mp_26ced217328f4737497bd6ba6641ca1c_mixpanel=%7B%22distinct_id%22%3A%20%229490581d-a1d2-4ebf-9355-e68bd65e8233%22%2C%22%24device_id%22%3A%20%22192cfb1734b530-00add237568357-26011951-1fa400-192cfb1734c530%22%2C%22%24initial_referrer%22%3A%20%22%24direct%22%2C%22%24initial_referring_domain%22%3A%20%22%24direct%22%2C%22__mps%22%3A%20%7B%7D%2C%22__mpso%22%3A%20%7B%7D%2C%22__mpus%22%3A%20%7B%7D%2C%22__mpa%22%3A%20%7B%7D%2C%22__mpu%22%3A%20%7B%7D%2C%22__mpr%22%3A%20%5B%5D%2C%22__mpap%22%3A%20%5B%5D%2C%22%24search_engine%22%3A%20%22google%22%2C%22%24user_id%22%3A%20%229490581d-a1d2-4ebf-9355-e68bd65e8233%22%7D; _ga_7B0KEDD7XP=GS1.1.1730061366.1.1.1730061574.0.0.0"

const newSunoApi = async (cookie: string) => {
  console.log("newSunoApi global method is called")
  const sunoApi = new SunoApi();
  await sunoApi.init(cookie);

  return sunoApi
}
     
if (!SUNO_COOKIE) {
  console.log("Environment does not contain SUNO_COOKIE.")
}

export const sunoApi = newSunoApi(SUNO_COOKIE || '');
