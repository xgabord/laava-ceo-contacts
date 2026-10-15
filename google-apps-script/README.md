# Google Contacts - egyszeri beallitas

1. Jelentkezz be a **callerid.laava@gmail.com** fiokkal a https://script.google.com/ oldalra, es hozz letre egy uj projektet.
2. Masold a `Code.gs` fajl tartalmat a szerkesztobe. A projektbeallitasoknal kapcsold be a **Show "appsscript.json" manifest file in editor** opciot, majd masold be az `appsscript.json` tartalmat is.
3. A **Project Settings -> Script properties** panelen add hozza: `CEO_SYNC_SECRET` = legalabb 32 karakteres veletlen titok. Ne ird GitHubba.
4. **Deploy -> New deployment -> Web app**: Execute as: **Me**, Who has access: **Anyone**. A fiokkal hagyd jova a Google Contacts jogositast. Masold ki a `https://script.google.com/macros/s/.../exec` URL-t.
5. Az xCloud app `.env` fajljaba allitsd:
   `GCONTACTS_SCRIPT_URL=https://script.google.com/macros/s/..../exec`
   `GCONTACTS_SCRIPT_SECRET=ugyanaz-a-hosszu-titok`
   `GCONTACTS_SYNC_ENABLED=true`
6. A bekapcsolas pillanataban a worker az aktualis IMAP UIDNEXT-et veszi kiindulasi pontnak. A korabbi leveleket nem kuldi a Google-be, csak a kesobb erkezo kulso feladok kozul az egyertelmu, egyetlen ervenyes telefonszammal es megbizhato nevvel rendelkezo kontaktokat.
7. A Google oldali feldolgozo minden mentes elott email es telefonszam szerint megnezi a mar letezo nevjegyeket; a `ceo-kontakt` nevjegycsoportot letrehozza, ha szukseges.

**Fontos**: Ez az elso integracios verzio. Az IMAP UID kurzor az app ujrainditasakor nullazodik; ujrainditas kozben beerkezo levelek kimaradhatnak. A tartos UID-allapot es a telefonszamok forrasának megbizhatobb ellenorzese szukseges egy teljesen onallo, vesztesegmentes szinkronhoz. Elozoleg felismert kontaktokat ne importalj ujra. Az alkalmazas nem kuld e-mail torzset a Googlenak, csak nev, email, telefonszam es ceg mezo ertekeit.

Security: az Apps Script Web app publikus vegpont, de minden keresnel ellenorzi az eros kozos titkot. A titkot csak a Script Properties es az xCloud privat kornyezete tarolja. Aki megszerzi ezt a titkot, nevjegyeket hozhat letre, ezert ne oszd meg.
