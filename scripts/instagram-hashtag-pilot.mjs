import { parseArgs } from "node:util";
import { InstagramPilotError, runInstagramHashtagPilot } from "../lib/providers/instagram-hashtag.ts";

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      hashtag: { type: "string", default: "#кофе" },
      limit: { type: "string", default: "10" },
      "published-from": { type: "string" },
      "published-to": { type: "string" },
      "min-likes": { type: "string" },
    } }));
  } catch {
    throw new InstagramPilotError("Допустимые параметры: --hashtag '#кофе', --limit 10, --published-from, --published-to, --min-likes.");
  }
  const minLikes = values["min-likes"];
  if (minLikes !== undefined && !/^\d+$/.test(minLikes)) {
    throw new InstagramPilotError("Минимум лайков должен быть целым неотрицательным числом.");
  }

  const result = await runInstagramHashtagPilot({
    hashtag: values.hashtag,
    limit: Number(values.limit),
    filters: {
      publishedFrom: values["published-from"],
      publishedTo: values["published-to"],
      minLikes: minLikes === undefined ? undefined : Number(minLikes),
    },
  }, {
    userId: process.env.KADR_INSTAGRAM_USER_ID,
    accessToken: process.env.KADR_INSTAGRAM_ACCESS_TOKEN,
    appSecret: process.env.KADR_INSTAGRAM_APP_SECRET,
  });
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof InstagramPilotError ? error.message : "Пилот Instagram завершился внутренней ошибкой.");
  process.exitCode = 1;
}
