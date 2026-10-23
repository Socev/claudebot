// Facturen-verzender — Merk verzendgeheim (wv921): alleen bereikbaar via de ware tak van de IF *Verzendgeheim?* (sha256 van het secret =
// die van n8n_verzender_versturen_secret). Zet json.verzendgeheim = true buiten body; de bijlagen gaan ongewijzigd mee naar *Toetsen*.
return $input.all().map((i) => ({ json: Object.assign({}, i.json, { verzendgeheim: true }), binary: i.binary }));
