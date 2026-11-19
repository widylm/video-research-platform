import assert from "node:assert/strict";
import test from "node:test";
import { checkVideoEmbed, parseVideoLink, resolveVideoLink } from "../../lib/public-video-url.ts";
import { videoEntrySchema } from "../../lib/video-entry.ts";

const tiktok = "https://www.tiktok.com/@scout2015/video/6718335390845095173";
const instagram = "https://www.instagram.com/reel/DR_Kadr00/";
const shortTikTok = "https://vm.tiktok.com/ZKadr123/";
const shortInstagram = "https://www.instagram.com/share/reel/Kadr123/";
const redirect = (location) => new Response(null, { status: 302, headers: { location } });

test("post links normalize hosts and remove tracking without fetching the publication", async () => {
  const fetch = () => assert.fail("A full URL must not be fetched by the resolver");
  const tik = await resolveVideoLink(" https://m.tiktok.com/@scout2015/video/6718335390845095173/?tracking=1#x ", fetch);
  assert.deepEqual(tik, { video: { platform: "tiktok", externalId: "6718335390845095173", url: tiktok, author: "scout2015" } });

  const reel = await resolveVideoLink("https://instagram.com/reels/DR_Kadr00?igsh=tracking", fetch);
  const post = await resolveVideoLink("https://instagram.com/p/DR_Kadr00/?igsh=tracking", fetch);
  assert.equal(reel.video.url, instagram);
  assert.equal(post.video.url, "https://www.instagram.com/p/DR_Kadr00/");
  assert.equal(post.video.externalId, reel.video.externalId);
});

test("video URLs reject non-post paths, misleading origins, credentials, ports and encoded path traversal", async () => {
  const invalid = [
    "https://www.instagram.com/account/",
    "https://www.tiktok.com/@scout2015/photo/6718335390845095173",
    "http://www.instagram.com/reel/DR_Kadr00/",
    "//www.instagram.com/reel/DR_Kadr00/",
    "javascript:alert(1)",
    "https://www.instagram.com.example.com/reel/DR_Kadr00/",
    "https://www.instagram.com@127.0.0.1/reel/DR_Kadr00/",
    "https://user@www.instagram.com/reel/DR_Kadr00/",
    "https://www.instagram.com:443/reel/DR_Kadr00/",
    "https://www.instagram.com:8080/reel/DR_Kadr00/",
    "https://www.instagram.com./reel/DR_Kadr00/",
    "https://www.instagram.com\\@example.com/reel/DR_Kadr00/",
    "https://www.instagram.com/share/Kadr123/%2e%2e/%2e%2e/reel/DR_Kadr00/",
    "https://www.instagram.com/reel/DR%2FKadr00/",
    "https://vt.tiktok.com/?next=http://169.254.169.254",
  ];
  for (const url of invalid) {
    assert.equal(parseVideoLink(url), null, url);
    assert.match((await resolveVideoLink(url, () => assert.fail(url))).error, /HTTPS-ссылку/);
  }
});

test("short links use only bounded same-platform HTTP redirects without forwarding parameters or cookies", async () => {
  const seen = [];
  const tik = await resolveVideoLink(shortTikTok + "?no-forward=1", async (url, options) => {
    seen.push(url);
    assert.equal(options.redirect, "manual");
    assert.equal(options.method, "HEAD");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return redirect(url === shortTikTok ? "https://www.tiktok.com/t/ZKadrSecond/?ignore=1" : tiktok + "?track=1");
  });
  assert.equal(tik.video.url, tiktok);
  assert.deepEqual(seen, [shortTikTok, "https://www.tiktok.com/t/ZKadrSecond/"]);
  const ig = await resolveVideoLink(shortInstagram, async () => redirect("/reel/DR_Kadr00/?igsh=track"));
  assert.equal(ig.video.url, instagram);

  for (const location of [
    "https://example.org/t/Kadr123/", "http://169.254.169.254/latest/", "//127.0.0.1/t/Kadr123/",
    "//www.tiktok.com:443/t/Kadr123/", shortInstagram, "https://www.tiktok.com/login", shortTikTok,
  ]) {
    let calls = 0;
    const result = await resolveVideoLink(shortTikTok, async () => {
      assert.equal(++calls, 1);
      return redirect(location);
    });
    assert.match(result.error, /короткую ссылку/);
    assert.equal(calls, 1);
  }

  let hops = 0;
  const chain = await resolveVideoLink(shortTikTok, async () => redirect(`/KadrHop${++hops}/`));
  assert.match(chain.error, /короткую ссылку/);
  assert.equal(hops, 4);
  assert.match((await resolveVideoLink(shortInstagram, async () => new Response(null, { status: 410 }))).error, /удалил/);
});

test("embed checks request only official oEmbed endpoints and distinguish unavailability from temporary errors", async () => {
  assert.equal(await checkVideoEmbed(instagram, async (url, options) => {
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(url.pathname, "/v27.0/instagram_oembed");
    assert.equal(url.searchParams.get("url"), instagram);
    assert.equal(options.redirect, "manual");
    return Response.json({ html: "<blockquote></blockquote>" });
  }), "available");
  assert.equal(await checkVideoEmbed(tiktok, async (url) => {
    assert.equal(url.origin + url.pathname, "https://www.tiktok.com/oembed");
    return new Response(null, { status: 404 });
  }), "unavailable");
  assert.equal(await checkVideoEmbed(instagram, async () => new Response("<html></html>")), "unknown");
  assert.equal(await checkVideoEmbed(instagram, async () => redirect("https://example.org")), "unknown");
  assert.equal(await checkVideoEmbed(instagram, async () => { throw new Error("timeout"); }), "unknown");
});

test("manual metadata preserves zero and validates dates, hashtags and count bounds", () => {
  const input = {
    url: instagram, description: "Чашка кофе", publishedAt: "", hashtags: "#Кофе, #кофе #Утро",
    views: "", likes: "0", collectionId: "",
  };
  const result = videoEntrySchema.parse(input);
  assert.equal(result.views, null);
  assert.equal(result.likes, 0);
  assert.equal(result.publishedAt, null);
  assert.deepEqual(result.hashtags, ["кофе", "утро"]);
  for (const views of ["-1", "1.5", "1e5", "9007199254740992"]) {
    assert.equal(videoEntrySchema.safeParse({ ...input, views }).success, false);
  }
  assert.equal(videoEntrySchema.safeParse({ ...input, publishedAt: "2026-02-29" }).success, false);
  assert.equal(videoEntrySchema.safeParse({ ...input, hashtags: "#bad-tag" }).success, false);
});
