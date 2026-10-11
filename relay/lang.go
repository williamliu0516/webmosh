package main

// The language of what people read: the page (site.json), and what the relay says itself (errors shown on the
// page or the hosts page, the setup script, ntfy). The config's "lang": "en" (the default) or "zh".
var zh bool

// L picks the English or the Chinese text. Formats keep their verbs in the same order in both, or index them.
func L(en, zhText string) string {
	if zh {
		return zhText
	}
	return en
}
