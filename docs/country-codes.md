# Country codes to choose from

Every country in the dial plan, grouped by region, with the prefix to use.
Tick the ones you want blocked and hand the list back — or paste the prefixes
straight into the bulk endpoint:

```bash
curl -X POST https://…/v1/rules/bulk \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prefixes":["234","91","92","880"]}'
```

The prefix is what goes in a rule. No `+`, no spaces.

## Read this before picking

**Blocking a country blocks everyone in it**, including anyone you know who
happens to be travelling and using a local SIM. If there is a number in a
blocked country you do talk to, add it as an **allow** rule with its full
digits — `234803…` beats `234` by being longer, and the longest rule always
wins.

**Do not block `1` on its own.** That is the entire North American Numbering
Plan — the US, Canada and 23 other countries. If you mean a specific one, use
its four-digit prefix from the [Caribbean](#caribbean-1-territories) table
below, or an individual US/Canada area code (`1917`, `1305`, …) from the
picker's second tab.

**Start with two or three.** The activity log will tell you within a day
whether they are catching what you meant. Adding more later is one call.

**These labels are advisory.** Matching works on digits alone, so a prefix that
is not on this list still works, and a country that renames itself does not
break anything.

---

## What a new account starts with

Every account is seeded with these 23 prefixes as **block** rules, from
`db/migrations/0006_starter_rules.sql` and `0007_starter_rules_trim.sql`. They
are yours from that moment — remove any you disagree with and it stays removed.

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Nigeria | `234` | | Philippines | `63` |
| Ghana | `233` | | Vietnam | `84` |
| Côte d'Ivoire | `225` | | Malaysia | `60` |
| Senegal | `221` | | Cambodia | `855` |
| Benin | `229` | | Myanmar | `95` |
| Togo | `228` | | Turkey | `90` |
| Cameroon | `237` | | Iraq | `964` |
| Kenya | `254` | | Jamaica | `1876` |
| Morocco | `212` | | Dominican Republic | `1809` `1829` `1849` |
| India | `91` | | | |
| Pakistan | `92` | | | |
| Bangladesh | `880` | | | |

### Deliberately not blocked

These reach subscribers normally. A guard in `0007` fails the migration if any
of them is ever put back on the starter list, rather than shipping it quietly —
add to that guard whenever a country comes off the block list.

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| South Africa | `27` | | Indonesia | `62` |
| Egypt | `20` | | China | `86` |
| United Arab Emirates | `971` | | Ukraine | `380` |
| Russia / Kazakhstan | `7` | | | |

Nothing happens to any blocked country until the account is armed. Until then
they show up in the activity log as `would_block`, which is how you check the
list is right before it can do anything.

To change what *new* accounts get, add a migration adjusting `starter_rules`.
Existing accounts keep the copy they were given; applying a change to them is a
deliberate act:

```sql
delete from rules where prefix in ('20','971','7','62','86','380');
```

---

## Every country by region

### West & Central Africa

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Angola | `244` | | Ghana | `233` |
| Benin | `229` | | Guinea | `224` |
| Burkina Faso | `226` | | Guinea-Bissau | `245` |
| Cameroon | `237` | | Liberia | `231` |
| Cape Verde | `238` | | Mali | `223` |
| Central African Republic | `236` | | Mauritania | `222` |
| Chad | `235` | | Niger | `227` |
| Congo - Brazzaville | `242` | | Nigeria | `234` |
| Congo - Kinshasa | `243` | | Sao Tome and Principe | `239` |
| Cote d'Ivoire | `225` | | Senegal | `221` |
| Equatorial Guinea | `240` | | Sierra Leone | `232` |
| Gabon | `241` | | Togo | `228` |
| Gambia | `220` | | | |

### East Africa & Indian Ocean

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| British Indian Ocean Territory | `246` | | Reunion / Mayotte | `262` |
| Burundi | `257` | | Rwanda | `250` |
| Comoros | `269` | | Saint Helena | `290` |
| Djibouti | `253` | | Seychelles | `248` |
| Eritrea | `291` | | Somalia | `252` |
| Ethiopia | `251` | | South Sudan | `211` |
| Kenya | `254` | | Sudan | `249` |
| Madagascar | `261` | | Tanzania | `255` |
| Mauritius | `230` | | Uganda | `256` |

### Southern Africa

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Botswana | `267` | | Namibia | `264` |
| Eswatini | `268` | | South Africa | `27` |
| Lesotho | `266` | | Zambia | `260` |
| Malawi | `265` | | Zimbabwe | `263` |
| Mozambique | `258` | | | |

### North Africa

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Algeria | `213` | | Morocco | `212` |
| Egypt | `20` | | Tunisia | `216` |
| Libya | `218` | | | |

### South Asia

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Afghanistan | `93` | | Maldives | `960` |
| Bangladesh | `880` | | Nepal | `977` |
| Bhutan | `975` | | Pakistan | `92` |
| India | `91` | | Sri Lanka | `94` |

### Southeast Asia

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Brunei | `673` | | Philippines | `63` |
| Cambodia | `855` | | Singapore | `65` |
| Indonesia | `62` | | Thailand | `66` |
| Laos | `856` | | Timor-Leste | `670` |
| Malaysia | `60` | | Vietnam | `84` |
| Myanmar | `95` | | | |

### East Asia

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| China | `86` | | Mongolia | `976` |
| Hong Kong | `852` | | North Korea | `850` |
| Japan | `81` | | South Korea | `82` |
| Macau | `853` | | Taiwan | `886` |

### Central Asia & Caucasus

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Armenia | `374` | | Tajikistan | `992` |
| Azerbaijan | `994` | | Turkmenistan | `993` |
| Georgia | `995` | | Uzbekistan | `998` |
| Kyrgyzstan | `996` | | | |

### Middle East

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Bahrain | `973` | | Palestine | `970` |
| Iran | `98` | | Qatar | `974` |
| Iraq | `964` | | Saudi Arabia | `966` |
| Israel | `972` | | Syria | `963` |
| Jordan | `962` | | Turkey | `90` |
| Kuwait | `965` | | United Arab Emirates | `971` |
| Lebanon | `961` | | Yemen | `967` |
| Oman | `968` | | | |

### Eastern Europe & Russia

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Albania | `355` | | Moldova | `373` |
| Belarus | `375` | | Montenegro | `382` |
| Bosnia and Herzegovina | `387` | | North Macedonia | `389` |
| Bulgaria | `359` | | Poland | `48` |
| Croatia | `385` | | Romania | `40` |
| Czechia | `420` | | Russia / Kazakhstan | `7` |
| Estonia | `372` | | Serbia | `381` |
| Hungary | `36` | | Slovakia | `421` |
| Kosovo | `383` | | Slovenia | `386` |
| Latvia | `371` | | Ukraine | `380` |
| Lithuania | `370` | | | |

### Western & Northern Europe

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Andorra | `376` | | Italy | `39` |
| Austria | `43` | | Liechtenstein | `423` |
| Belgium | `32` | | Luxembourg | `352` |
| Cyprus | `357` | | Malta | `356` |
| Denmark | `45` | | Monaco | `377` |
| Faroe Islands | `298` | | Netherlands | `31` |
| Finland | `358` | | Norway | `47` |
| France | `33` | | Portugal | `351` |
| Germany | `49` | | San Marino | `378` |
| Gibraltar | `350` | | Spain | `34` |
| Greece | `30` | | Sweden | `46` |
| Greenland | `299` | | Switzerland | `41` |
| Iceland | `354` | | United Kingdom | `44` |
| Ireland | `353` | | | |

### Latin America

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Argentina | `54` | | Guatemala | `502` |
| Aruba | `297` | | Guyana | `592` |
| Belize | `501` | | Haiti | `509` |
| Bolivia | `591` | | Honduras | `504` |
| Brazil | `55` | | Martinique | `596` |
| Chile | `56` | | Mexico | `52` |
| Colombia | `57` | | Nicaragua | `505` |
| Costa Rica | `506` | | Panama | `507` |
| Cuba | `53` | | Paraguay | `595` |
| Curacao / Caribbean Netherlands | `599` | | Peru | `51` |
| Ecuador | `593` | | Saint Pierre and Miquelon | `508` |
| El Salvador | `503` | | Suriname | `597` |
| Falkland Islands | `500` | | Uruguay | `598` |
| French Guiana | `594` | | Venezuela | `58` |
| Guadeloupe / Saint Martin | `590` | | | |

### Caribbean (+1 territories)

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| Anguilla | `1264` | | Jamaica | `1658` |
| Antigua and Barbuda | `1268` | | Jamaica | `1876` |
| Bahamas | `1242` | | Montserrat | `1664` |
| Barbados | `1246` | | Puerto Rico | `1787` |
| Bermuda | `1441` | | Puerto Rico | `1939` |
| British Virgin Islands | `1284` | | Saint Kitts and Nevis | `1869` |
| Cayman Islands | `1345` | | Saint Lucia | `1758` |
| Dominica | `1767` | | Saint Vincent and the Grenadines | `1784` |
| Dominican Republic | `1809` | | Sint Maarten | `1721` |
| Dominican Republic | `1829` | | Trinidad and Tobago | `1868` |
| Dominican Republic | `1849` | | Turks and Caicos Islands | `1649` |
| Grenada | `1473` | | U.S. Virgin Islands | `1340` |

### Oceania

| Country | Prefix | | Country | Prefix |
|---|---|---|---|---|
| American Samoa | `1684` | | Niue | `683` |
| Australia | `61` | | Northern Mariana Islands | `1670` |
| Cook Islands | `682` | | Palau | `680` |
| Fiji | `679` | | Papua New Guinea | `675` |
| French Polynesia | `689` | | Samoa | `685` |
| Guam | `1671` | | Solomon Islands | `677` |
| Kiribati | `686` | | Tokelau | `690` |
| Marshall Islands | `692` | | Tonga | `676` |
| Micronesia | `691` | | Tuvalu | `688` |
| Nauru | `674` | | Vanuatu | `678` |
| New Caledonia | `687` | | Wallis and Futuna | `681` |
| New Zealand | `64` | | | |
---

## US and Canada area codes

There are 412 of them in the dial plan and they are best picked from the
dashboard's **Browse codes → US & Canada area codes** tab, which searches by
name and digits. To add one by API, use the dialled form — `1` followed by the
three digits:

```bash
# the 917 area code
curl -X POST https://…/v1/rules \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prefix":"1917"}'

# or let the service prefix it for you
  -d '{"prefix":"917","area_code":true}'
```

Without `area_code`, a bare `917` is taken literally and matches any number
starting 917 — which is not what you meant.

## Non-geographic +1 ranges

Worth knowing about, since automated calls and messages often come from them.

| Range | Prefix |
|---|---|
| Toll-free | `1800` `1833` `1844` `1855` `1866` `1877` `1888` |
| Premium rate | `1900` |
| US Government | `1710` |
