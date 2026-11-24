// Header login buttons are present even on healthy guest searches.
// Only explicit blocking text, with no visible videos, identifies a failed page.
export function pageIssue(text, visibleVideos) {
  if (/log in to (?:search|see (?:more |the )?(?:search results|results|videos))|войдите.{0,60}(?:результат|поиск|видео)/i.test(text)) {
    return {phase:'waiting',message:'TikTok требует вход для продолжения выдачи. Часть роликов может быть видна, но поиск не завершён. Войди вручную в окне TikTok и повтори сбор.'};
  }
  if (visibleVideos > 0) return null;
  if (/передвиньте ползунок|совместить пазл|verify to continue|drag the slider|complete the puzzle/i.test(text)) {
    return {phase:'waiting',message:'TikTok показал CAPTCHA. Пройди проверку в окне TikTok, дождись видео и снова нажми «Собрать». Это не пустая выдача поиска.'};
  }
  if (/что-то пошло не так|что-то случилось с нашим сервером|something went wrong|something happened with our server|couldn.t load|unable to load|нет подключения к интернету/i.test(text)) {
    return {phase:'waiting',message:'TikTok не загрузил результаты поиска: на самой странице показана ошибка. Количество видео определить нельзя. Открой окно TikTok, нажми «Попробовать ещё раз» и повтори сбор после появления роликов.'};
  }
  return null;
}

export function explicitEmptyPage(text) {
  return /no results found|no videos found|ничего не найдено|результатов не найдено|видео не найдено/i.test(text);
}
