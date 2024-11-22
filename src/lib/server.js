// server.js

const express = require("express");
const { sunoApi, DEFAULT_MODEL } = require("./SunoApi.js");
const app = express();
const port = process.env.PORT || process.argv[2] || 3000;

// Middleware to parse incoming JSON requests
app.use(express.json()); // To parse JSON bodies

// 0. GET /api/clip
app.get("/api/clip", async (req, res) => {
  try {
    const { id } = req.query;
    const audioInfo = await (await sunoApi).getClip(id);
    res.json(audioInfo); // Return empty JSON object
  } catch (e) {
    console.log("/api/clip Exception: e: ", e);
    res.json({ error: e });
  }
});

// 1. POST /api/generate
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, make_instrumental, model, wait_audio } = req.body;
    console.log({ prompt, make_instrumental, wait_audio }); // You can log the values if needed

    const audioInfo = await (
      await sunoApi
    ).generate(prompt, make_instrumental, model || DEFAULT_MODEL, wait_audio);
    res.json(audioInfo); // Return empty JSON object
  } catch (e) {
    console.log("/api/generate Exception: e: ", e);
    res.json({ error: e });
  }
});

// 2. POST /v1/chat/completions
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages } = req.body;
    console.log({ messages }); // You can log the prompt if needed

    let userMessage = null;
    for (let message of messages) {
      if (message.role == "user") {
        userMessage = message;
      }
    }
    if (!userMessage) {
      res.json({ error: "Prompt message is required" });
      return;
    }

    const audioInfo = await (
      await sunoApi
    ).generate(userMessage.content, true, DEFAULT_MODEL, true);
    const audio = audioInfo[0];
    const data = `## Song Title: ${audio.title}\n![Song Cover](${audio.image_url})\n### Lyrics:\n${audio.lyric}\n### Listen to the song: ${audio.audio_url}`;

    res.json(data); // Return empty JSON object
  } catch (e) {
    console.log("/v1/chat/completions Exception: e: ", e);
    res.json({ error: e });
  }
});

// 3. POST /api/custom_generate
app.post("/api/custom_generate", async (req, res) => {
  try {
    const {
      prompt,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags,
    } = req.body;
    console.log({
      prompt,
      tags,
      title,
      make_instrumental,
      model,
      wait_audio,
      negative_tags,
    });

    const audioInfo = await (
      await sunoApi
    ).custom_generate(
      prompt,
      tags,
      title,
      make_instrumental,
      model || DEFAULT_MODEL,
      wait_audio,
      negative_tags
    );
    res.json(audioInfo); // Return empty JSON object
  } catch (e) {
    console.log("/api/custom_generate Exception: e: ", e);
    res.json({ error: e });
  }
});

// 4. POST /api/extend_audio
app.post("/api/extend_audio", async (req, res) => {
  try {
    const { audio_id, prompt, continue_at, title, tags } = req.body;
    console.log({ audio_id, prompt, continue_at, title, tags, model });
    const audioInfo = await (
      await sunoApi
    ).extendAudio(
      audio_id,
      prompt,
      continue_at,
      tags,
      title,
      model || DEFAULT_MODEL
    );
    res.json(audioInfo); // Return empty JSON object
  } catch (e) {
    console.log("/api/extend_audio Exception: e: ", e);
    res.json({ error: e });
  }
});

// 5. POST /api/generate_lyrics
app.post("/api/generate_lyrics", async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log({ prompt }); // You can log the prompt if needed
    const lyrics = await (await sunoApi).generateLyrics(prompt);
    res.json(lyrics); // Return empty JSON object
  } catch (e) {
    console.log("/api/generate_lyrics Exception: e: ", e);
    res.json({ error: e });
  }
});

// 6. GET /api/get
app.get("/api/get", async (req, res) => {
  try {
    const { ids } = req.query;

    const songIds = ids;

    console.log("songIds:", songIds); // You can log the ids array if needed

    let audioInfo = [];
    if (songIds && songIds.length > 0) {
      const idsArray = songIds.split(",");
      audioInfo = await (await sunoApi).get(idsArray);
    } else {
      audioInfo = await (await sunoApi).get();
    }

    res.json(audioInfo); // Return empty JSON object
  } catch (e) {
    console.log("/api/get Exception: e: ", e);
    res.json({ error: e });
  }
});

// 7. GET /api/get_limit
app.get("/api/get_limit", async (req, res) => {
  try {
    const limit = await (await sunoApi).get_credits();
    res.json(limit); // Return empty JSON object
  } catch (e) {
    console.log("/api/get_limit Exception: e: ", e);
    res.json({ error: e });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
