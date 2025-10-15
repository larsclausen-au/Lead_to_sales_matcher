Lead to Sales Matcher (Client-side)

A client-only CSV matching tool. Upload two CSVs (AutoUncle leads and Dealer sales), compute match probabilities, and download an enriched sales CSV.

Usage
- Open `index.html` in a modern browser
- Upload `AutoUncle Lead data.csv` and `Dealer Sales data.csv`
- Click Match → review preview → Download matched CSV

Features
- Exact email/phone/name forces 100% probability
- Anonymized name/email pattern matching
- Viewed car brand/model parsed from `seller_car_url` vs sale `Typ`
- Location support: lead `owner_name` vs sale `Standort` (normalized)
- Greedy unique assignment per lead, sorted by probability

Tech
- Papa Parse 5.4.1
- Vanilla JS/HTML/CSS (no backend)


