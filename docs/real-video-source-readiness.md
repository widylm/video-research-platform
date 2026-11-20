# Пилот реального источника видео

Проверено по документации платформ 20 ноября 2026 года. Первый источник для «Кадра» — Instagram Hashtag Search через Graph API v27.0 с Facebook Login. Пилот запускается вручную из защищённого терминала и получает до 10 публичных Reels по одному точному хэштегу. В среде разработки нет одобренного доступа, токена пользователя и ID связанного аккаунта Meta. Живой запрос ещё предстоит проверить. [Instagram Hashtag Search](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search) · [Версии Graph API](https://developers.facebook.com/docs/graph-api/guides/versioning)

## Какие источники подходят

| Источник | Ключевые слова, хэштеги и аккаунты | Доступ и поля |
| --- | --- | --- |
| Instagram Hashtag Search | Чужие публичные публикации по точному хэштегу. `recent_media` охватывает последние 24 часа, `top_media` даёт популярные записи. Произвольный текст и исторический период не поддерживаются. | App Review для `Instagram Public Content Access` и `instagram_basic`, связанный профессиональный аккаунт и Facebook User Access Token. Есть `permalink`, подпись, дата, тип, счётчик комментариев и видимые лайки. Имя автора и просмотры недоступны. [Поля и ограничения `recent_media`](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-hashtag/recent-media) |
| Instagram Business Discovery | Публикации известного аккаунта Business или Creator по точному username. Темы можно отбирать в полученной выборке. | Facebook Login и разрешения для Business Discovery. Есть username, permalink, подпись, дата и доступные счётчики, включая `view_count` при наличии. Охват и определение просмотров зависят от поля API. [Business Discovery](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery) |
| TikTok Display API | Публичные видео подключившихся авторов. Текст и хэштеги фильтруются в полученных описаниях. Глобального поиска по TikTok этот API не предоставляет. | Одобрение приложения и продуктов Login Kit и TikTok API, OAuth каждого автора с `video.list`. До 20 видео за вызов списка. Можно запросить ID, `share_url`, название, описание, дату, просмотры, лайки и число комментариев. [Подключение](https://developers.tiktok.com/docs/en/display-api-get-started/) · [Список видео](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-list/) · [Поля видео](https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object/) |
| TikTok Research API | Публичные видео по словам в описании, хэштегам, авторам и датам. | `research.data.basic` и одобрение конкретного исследования. TikTok требует независимый некоммерческий проект в общественных интересах и соответствие критериям организации и региона. Коммерческий поиск «Кадра» этим доступом не покрывается. [Допуск](https://developers.tiktok.com/products/research-api/) · [Параметры поиска](https://developers.tiktok.com/docs/en/research-api-specs-query-videos) |
| Meta Content Library API | Исследовательский поиск по публичным публикациям, включая поиск по тексту. | Заявка и отдельный допуск для подходящего исследовательского проекта. Рабочая среда и экспорт подчиняются правилам этого продукта. [Допуск](https://developers.facebook.com/docs/content-library-and-api/get-access) · [Поиск публикаций Instagram](https://developers.facebook.com/docs/content-library-and-api/content-library-api/guides/ig-posts/) |

Документация не даёт оснований обещать 500–1000 произвольных видео по любому запросу. Даже по популярному хэштегу часть результатов может быть фото, обычными видеопубликациями или ссылками вида `/p/`, где Hashtag Search не подтверждает тип Reels. Результаты пилота включают только `VIDEO` с официальным permalink вида `/reel/`. [Instagram Media](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media) · [Лимиты `recent_media`](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-hashtag/recent-media)

## Что подготовить в Meta

1. Свяжите рабочий аккаунт Instagram Business или Creator со страницей Facebook. Facebook-пользователь, который выдаёт токен, должен иметь необходимые задачи на этой странице. В своём Meta-приложении настройте Instagram API with Facebook Login и Facebook Login for Business. [Подключение](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/get-started)
2. В App Review запросите функцию **Instagram Public Content Access** и разрешение **`instagram_basic`** для описанного пилота. Покажите цель, используемые поля, кто увидит результаты и как они удаляются. Для пользователя с ролью страницы, выданной через Business Manager, справка требует одно из `pages_read_engagement`, `business_management` или `ads_management`. Для чтения выберите `pages_read_engagement`, если применимо. `pages_show_list` нужен для получения списка страниц через `/me/accounts`. Если Meta требует Advanced Access, пройдите App Review и Business Verification. [Требования Hashtag Search](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-hashtag-search) · [Уровни доступа](https://developers.facebook.com/documentation/instagram-platform/overview#access-levels)
3. Если у приложения пока нет проверяемого интерфейса и Facebook Login, уточните путь ревью в Meta перед запуском. Документация ограничивает запросы private apps, которые ревьюер не может проверить. Ручная команда из этого PR предназначена для уже одобренного приложения. Она не заменяет проверяемый OAuth-сценарий для App Review. [Private apps](https://developers.facebook.com/documentation/instagram-platform/overview#app-review)
4. В Graph API Explorer выберите одобренное приложение, Graph API v27.0 и **Get User Access Token**. Через `GET /me/accounts?fields=id,name` найдите нужную страницу. Затем `GET /<PAGE_ID>?fields=instagram_business_account` вернёт `instagram_business_account.id`. В терминале используйте этот ID и токен Facebook-пользователя, который выдал разрешения приложению. [Graph API Explorer](https://developers.facebook.com/docs/graph-api/guides/explorer/) · [Получение ID и токена](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/get-started)

App Review подтверждает описанный сценарий доступа. Перед командным хранением метаданных проверьте, что заявка охватывает этот сценарий, а срок хранения, доступ команды и удаление данных соответствуют применимым условиям и политике приватности. Для подключаемых приложений Meta требует доступной инструкции по удалению данных. Пилот выводит только метаданные в терминал. Согласование импорта и сроков хранения остаётся отдельным этапом. [Meta Platform Terms](https://developers.facebook.com/terms/) · [Удаление данных](https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback)

## Ручной запуск после одобрения

В Bash из корня репозитория с Node.js 22.12 или новее и установленными зависимостями выполните команды ниже. Ввод токена скрыт. Для приложения с `Require App Secret` также введите `KADR_INSTAGRAM_APP_SECRET` через `read -rsp 'Meta App Secret: ' KADR_INSTAGRAM_APP_SECRET` и экспортируйте его внутри тех же круглых скобок. [App Secret Proof](https://developers.facebook.com/docs/graph-api/guides/secure-requests/)

```bash
(
  set +x
  read -rp 'Instagram professional account ID: ' KADR_INSTAGRAM_USER_ID
  read -rsp 'Facebook User Access Token: ' KADR_INSTAGRAM_ACCESS_TOKEN
  printf '\n'
  export KADR_INSTAGRAM_USER_ID KADR_INSTAGRAM_ACCESS_TOKEN
  npm run --silent pilot:instagram -- --hashtag '#кофе' --limit 10
)
```

Можно задать `--published-from` и `--published-to` как ISO-моменты с часовым поясом и `--min-likes` как целое неотрицательное число. Отсутствующие значения остаются `null`, в том числе время, если оно не пришло, и скрытые лайки. Подтверждённый ноль сохраняется. Хэштеги извлекаются из подписи. Фильтр просмотров в команде недоступен, поскольку `recent_media` не предоставляет просмотры.

Отчёт показывает `apiRequests`, число строк `apiMediaRows` от Meta, `reelsWithPermalink` до фильтров и дедупликации, `matchedVideos` после них, отсутствующие поля `missing` и причину остановки. Список `videos` содержит максимум 10 уникальных результатов. Лимит запуска — один запрос для ID хэштега и до трёх страниц метаданных, по 10 строк максимум на каждой. `apiFeeUsd` равен `0`, поскольку пилот использует обычные чтения Graph API без платных продуктов. Это бюджет запросов адаптера, а не показание биллинга Meta. Квота платформы расходуется. Для Hashtag Search она ограничена 30 уникальными хэштегами за скользящие семь дней, также действуют обычные лимиты Graph API. При отказе в доступе, 429 или ошибке пилот завершится с диагностикой и без результатов. [Лимиты хэштегов](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search) · [Лимиты Graph API](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)

Пилот использует отдельную серверную команду. Действующий экран массового поиска в приложении помечен как демо. Проверки контракта выполняются на HTTP-моках, в том числе для отсутствия токена, пагинации, фильтров, нулевых и неизвестных полей, ошибок и отказа в импорте `mock:*`.

```bash
node --experimental-strip-types --test tests/e2e/instagram-hashtag.test.mjs
```
