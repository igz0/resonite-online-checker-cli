import fetch from "node-fetch";
import signalR from "@microsoft/signalr";
import crypto from "crypto";
import readline from "node:readline";

const API_BASE_URL = "https://api.resonite.com";
const SESSION_CACHE_INTERVAL_MILLISECONDS = 10000;

class ApiClient {
  constructor() {
    this.machineId = crypto.randomBytes(32).toString("base64url");
    this.uid = this.sha256(this.machineId);
    this.session_token = null;
    this.user_id = null;
    this.secretMachineId = crypto.randomUUID();
  }

  sha256(s) {
    const hash = crypto.createHash("sha256");
    hash.update(s);
    return hash.digest().toString("hex");
  }

  async request(url, init = {}) {
    const initobj = {
      ...init,
      headers: {
        ...init.headers,
        UID: this.uid,
        Authorization: this.session_token ? this.authorization() : undefined,
      },
    };
    return fetch(url, initobj);
  }

  async login(identity, password) {
    const login_credentials = {
      ownerId: null,
      email: null,
      username: null,
      authentication: { $type: "password", password },
      secretMachineId: this.secretMachineId,
      rememberMe: false,
    };

    if (identity.startsWith("U-")) {
      login_credentials.ownerId = identity;
    } else if (identity.indexOf("@") > 0) {
      login_credentials.email = identity;
    } else {
      login_credentials.username = identity;
    }

    const result = await this.request(`${API_BASE_URL}/userSessions`, {
      method: "POST",
      body: JSON.stringify(login_credentials),
      headers: { "Content-Type": "application/json" },
    });

    if (result.status !== 200) {
      return null;
    }

    const user_session_result = await result.json();
    this.user_id = user_session_result.entity.userId;
    this.session_token = user_session_result.entity.token;
    return user_session_result;
  }

  async logout() {
    if (!this.session_token) return;

    const result = await this.request(
      `${API_BASE_URL}/userSessions/${this.user_id}/${this.session_token}`,
      { method: "DELETE" }
    );
    console.log(result.status + " " + result.statusText);
  }

  authorization() {
    return this.session_token
      ? "res " + this.user_id + ":" + this.session_token
      : null;
  }
}

let sessionCache = [];
const friends = {};

function getActiveWorldFromCache(userID) {
  for (let session of sessionCache) {
    for (let user of session.sessionUsers) {
      if (user.userID === userID && user.isPresent) {
        return session.name;
      }
    }
  }

  return null;
}

async function updateSessionCache() {
  const sessionsResponse = await fetch(
    `${API_BASE_URL}/sessions?includeEmptyHeadless=false&minActiveUsers=1`
  );

  if (!sessionsResponse.ok) {
    throw new Error("Failed to fetch sessions.");
  }

  sessionCache = await sessionsResponse.json();
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  const client = new ApiClient();

  const id = await question("Enter your ID: ");
  const password = await question("Enter your password: ");

  const login_result = (await client.login(id, password))?.entity;

  if (!login_result) {
    console.log("Login error");
    process.exit(1);
  }

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(`${API_BASE_URL}/hub`, {
      headers: { Authorization: client.authorization() },
    })
    .configureLogging(signalR.LogLevel.Information)
    .build();

  connection.on("debug", (message) => {});

  connection.on("receivesessionupdate", (message) => {});

  connection.on("removesession", (message) => {});

  connection.on("sendstatustouser", (message) => {});

  connection.on("receivestatusupdate", async (message) => {
    const currentWorld = getActiveWorldFromCache(message.userId);
    message.userId = message.userId.replace("U-", "");

    friends[message.userId] = {
      Status: message.onlineStatus,
      "World Name": currentWorld || "Private",
    };
    console.table(friends);
    console.log("Enter to stop");
  });

  const sessionUpdateIntervalId = setInterval(
    updateSessionCache,
    SESSION_CACHE_INTERVAL_MILLISECONDS
  );

  await connection.start();
  await connection.invoke("InitializeStatus");
  await updateSessionCache();
  await connection.invoke("RequestStatus", null, false);

  rl.question("Enter to stop\n", async (answer) => {
    clearInterval(sessionUpdateIntervalId);
    await connection.stop();
    await client.logout();
    rl.close();
  });
}

main();
