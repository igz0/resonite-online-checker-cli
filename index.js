import fetch from "node-fetch";
import signalR from "@microsoft/signalr";
import crypto from "crypto";
import readline from "node:readline";

const API_BASE_URL = "https://api.resonite.com";
const SESSION_CACHE_INTERVAL_MILLISECONDS = 10000;
const MAX_CONNECTION_RETRIES = 5;

class ApiClient {
  constructor() {
    this.machineId = crypto.randomBytes(32).toString("base64url");
    this.uid = this.sha256(this.machineId);
    this.sessionToken = null;
    this.userId = null;
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
        Authorization: this.sessionToken ? this.authorization() : undefined,
      },
    };
    return fetch(url, initobj);
  }

  async login(identity, password) {
    const loginCredentials = {
      ownerId: null,
      email: null,
      userName: null,
      authentication: { $type: "password", password },
      secretMachineId: this.secretMachineId,
      rememberMe: false,
    };

    if (identity.startsWith("U-")) {
      loginCredentials.ownerId = identity;
    } else if (identity.indexOf("@") > 0) {
      loginCredentials.email = identity;
    } else {
      loginCredentials.userName = identity;
    }

    const result = await this.request(`${API_BASE_URL}/userSessions`, {
      method: "POST",
      body: JSON.stringify(loginCredentials),
      headers: { "Content-Type": "application/json" },
    });

    if (result.status !== 200) {
      return null;
    }

    const userSessionResult = await result.json();
    this.userId = userSessionResult.entity.userId;
    this.sessionToken = userSessionResult.entity.token;
    return userSessionResult;
  }

  async logout() {
    if (!this.sessionToken) return;

    const result = await this.request(
      `${API_BASE_URL}/userSessions/${this.userId}/${this.sessionToken}`,
      { method: "DELETE" }
    );
    console.log(result.status + " " + result.statusText);
  }

  authorization() {
    return this.sessionToken
      ? "res " + this.userId + ":" + this.sessionToken
      : null;
  }
}

let sessionCache = [];
const friends = {};

function getActiveWorldFromCache(userId) {
  for (let session of sessionCache) {
    for (let user of session.sessionUsers) {
      if (user.userID === userId && user.isPresent) {
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

  const loginResult = (await client.login(id, password))?.entity;

  if (!loginResult) {
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

  let isConnected = false;
  for (let i = 0; i < MAX_CONNECTION_RETRIES; i++) {
    try {
      await connection.start();
      isConnected = true;
      console.log("Connected to SignalR hub successfully.");
      break; // If connected successfully, exit the loop
    } catch {
      console.error(
        `Failed to connect. Retrying in 5 seconds... (${
          i + 1
        }/${MAX_CONNECTION_RETRIES} attempts)`
      );
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
    }
  }

  if (!isConnected) {
    console.error("Connection failed. Please try again after some time.");
    process.exit(1);
  }

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
