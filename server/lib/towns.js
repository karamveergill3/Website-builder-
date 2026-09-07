/**
 * Towns to hunt in, grouped the way someone actually thinks about territory.
 *
 * There is no "every town" button and there should not be: the UK has
 * thousands, and the hunt works through every TRADE times every TOWN. Eighty
 * trades against a thousand towns is eighty thousand combinations, which is
 * not coverage — it is a queue nobody reaches the end of. A region at a time
 * is the honest unit.
 *
 * SPELLING IS LOAD-BEARING. These strings go to the Companies House advanced
 * search as its `location` filter, which partial-matches the locality line of
 * a registered office address. So each name has to be written the way it
 * appears on an envelope — 'Stoke-on-Trent', not 'Stoke on Trent'.
 *
 * And a place only earns a line if post is actually addressed to it. Wellington
 * has twenty-five thousand people and is not here, because its addresses say
 * Telford; listing it would add a target that quietly returns nothing for ever.
 * Same for Aldridge and Bloxwich (addressed Walsall), Wednesfield and
 * Tettenhall (Wolverhampton), Hanley and Burslem (Stoke-on-Trent). The parent
 * town covers them.
 */

export const REGIONS = [
  {
    key: 'staffordshire',
    label: 'Staffordshire',
    note: 'Home ground for a Stafford business. Includes the Potteries.',
    towns: [
      'Stoke-on-Trent', 'Tamworth', 'Newcastle-under-Lyme',
      'Burton-on-Trent', 'Stafford', 'Lichfield',
      'Cannock', 'Burntwood', 'Rugeley',
      'Kidsgrove', 'Leek', 'Biddulph',
      'Hednesford', 'Stone', 'Wombourne',
      'Uttoxeter', 'Cheadle', 'Great Wyrley',
      'Perton', 'Cheslyn Hay', 'Penkridge',
      'Kinver', 'Codsall', 'Eccleshall',
    ],
  },
  {
    key: 'west-midlands',
    label: 'West Midlands',
    note: 'The metropolitan county: Birmingham out to the Black Country.',
    towns: [
      'Birmingham', 'Coventry', 'Wolverhampton',
      'Solihull', 'Sutton Coldfield', 'Dudley',
      'West Bromwich', 'Walsall', 'Stourbridge',
      'Halesowen', 'Smethwick', 'Rowley Regis',
      'Tipton', 'Wednesbury', 'Willenhall',
      'Oldbury', 'Bilston', 'Kingswinford',
      'Brierley Hill', 'Cradley Heath',
    ],
  },
  {
    key: 'shropshire',
    label: 'Shropshire',
    note: 'Telford and Shrewsbury westward.',
    towns: [
      'Telford', 'Shrewsbury', 'Oswestry',
      'Bridgnorth', 'Market Drayton', 'Newport',
      'Ludlow', 'Whitchurch', 'Shifnal',
      'Wem', 'Broseley', 'Church Stretton',
      'Ellesmere', 'Cleobury Mortimer', 'Much Wenlock',
      'Craven Arms', 'Bishops Castle',
    ],
  },
  {
    key: 'worcestershire',
    label: 'Worcestershire',
    note: 'South of the Black Country.',
    towns: [
      'Worcester', 'Redditch', 'Kidderminster',
      'Malvern', 'Bromsgrove', 'Droitwich',
      'Evesham', 'Stourport-on-Severn', 'Bewdley',
      'Pershore', 'Tenbury Wells', 'Upton-upon-Severn',
    ],
  },
  {
    key: 'warwickshire',
    label: 'Warwickshire',
    note: 'Coventry’s hinterland, east to Rugby.',
    towns: [
      'Nuneaton', 'Rugby', 'Leamington Spa',
      'Warwick', 'Bedworth', 'Stratford-upon-Avon',
      'Kenilworth', 'Atherstone', 'Southam',
      'Studley', 'Coleshill', 'Wellesbourne',
      'Alcester', 'Polesworth', 'Bidford-on-Avon',
      'Shipston-on-Stour', 'Henley-in-Arden',
    ],
  },
  {
    key: 'derbyshire',
    label: 'Derbyshire',
    note: 'North-east, Derby up to the Peak.',
    towns: [
      'Derby', 'Chesterfield', 'Swadlincote',
      'Ilkeston', 'Long Eaton', 'Glossop',
      'Buxton', 'Belper', 'Dronfield',
      'Ripley', 'Staveley', 'Heanor',
      'Bolsover', 'Eckington', 'Matlock',
      'New Mills', 'Shirebrook', 'Clay Cross',
      'South Normanton', 'Killamarsh', 'Ashbourne',
      'Sandiacre', 'Chapel-en-le-Frith', 'Alfreton',
      'Clowne', 'Whaley Bridge', 'Darley Dale',
      'Wirksworth', 'Melbourne', 'Bakewell',
    ],
  },
  {
    key: 'cheshire',
    label: 'Cheshire',
    note: 'North-west, Chester across to Warrington.',
    towns: [
      'Warrington', 'Chester', 'Crewe',
      'Runcorn', 'Widnes', 'Ellesmere Port',
      'Macclesfield', 'Northwich', 'Winsford',
      'Congleton', 'Wilmslow', 'Sandbach',
      'Nantwich', 'Neston', 'Poynton',
      'Middlewich', 'Knutsford', 'Alsager',
      'Lymm', 'Frodsham', 'Bollington',
      'Holmes Chapel', 'Alderley Edge',
    ],
  },
  {
    key: 'greater-manchester',
    label: 'Greater Manchester',
    note: 'A second conurbation, if the Midlands runs dry.',
    towns: [
      'Manchester', 'Salford', 'Bolton',
      'Rochdale', 'Stockport', 'Wigan',
      'Oldham', 'Bury', 'Sale',
      'Altrincham', 'Ashton-under-Lyne', 'Stretford',
      'Middleton', 'Leigh', 'Urmston',
      'Eccles', 'Hyde', 'Denton',
      'Walkden', 'Radcliffe', 'Chadderton',
      'Prestwich', 'Whitefield', 'Heywood',
      'Ashton-in-Makerfield', 'Swinton', 'Farnworth',
      'Cheadle Hulme', 'Westhoughton', 'Hindley',
      'Stalybridge', 'Marple', 'Droylsden',
      'Atherton', 'Shaw', 'Royton',
      'Failsworth', 'Horwich', 'Dukinfield',
      'Irlam', 'Ramsbottom', 'Tyldesley',
      'Littleborough', 'Cheadle', 'Standish',
      'Milnrow', 'Golborne', 'Mossley',
    ],
  },
  {
    key: 'west-yorkshire',
    label: 'West Yorkshire',
    note: 'Leeds and Bradford.',
    towns: [
      'Leeds', 'Bradford', 'Huddersfield',
      'Wakefield', 'Halifax', 'Dewsbury',
      'Keighley', 'Batley', 'Castleford',
      'Brighouse', 'Pontefract', 'Morley',
      'Shipley', 'Pudsey', 'Ossett',
      'Normanton', 'Mirfield', 'Bingley',
      'Heckmondwike', 'Birstall', 'Cleckheaton',
      'Todmorden', 'Featherstone', 'Ilkley',
      'Baildon', 'Elland', 'Otley',
      'Hemsworth', 'Knottingley', 'Liversedge',
      'Sowerby Bridge', 'Wetherby', 'South Kirkby',
      'Horbury', 'Meltham', 'Holmfirth',
      'Silsden', 'South Elmsall', 'Hebden Bridge',
    ],
  },
  {
    key: 'merseyside',
    label: 'Merseyside',
    note: 'Liverpool and the Wirral.',
    towns: [
      'Liverpool', 'Wirral', 'St Helens',
      'Southport', 'Birkenhead', 'Wallasey',
      'Bootle', 'Crosby', 'Kirkby',
      'Huyton', 'Formby', 'Newton-le-Willows',
      'Maghull', 'Halewood', 'Bebington',
      'Prenton', 'Litherland', 'Heswall',
      'Whiston', 'Bromborough', 'West Kirby',
      'Moreton', 'Haydock', 'Prescot',
      'Rainhill', 'Rainford', 'Hoylake',
    ],
  },
];

/** Every region, without the town lists — enough to draw the buttons. */
export const regionList = () =>
  REGIONS.map(({ key, label, note, towns }) =>
    ({ key, label, note, count: towns.length }));

/** The towns for one region, or null if the key is unknown. */
export function townsFor(key) {
  const region = REGIONS.find((r) => r.key === key);
  return region ? [...region.towns] : null;
}

/**
 * Merge new towns into a list the user has already typed, keeping theirs and
 * their order. Compared case- and punctuation-insensitively so re-clicking a
 * region does not add 'stoke on trent' alongside 'Stoke-on-Trent'.
 */
export function mergeTowns(existing = [], adding = []) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const seen = new Set(existing.map(norm).filter(Boolean));
  const out = [...existing];
  for (const town of adding) {
    const k = norm(town);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(town);
  }
  return out;
}
