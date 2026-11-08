'use strict'

/**
 * Minimal demo data for Lost N Found — RVU Mysore only.
 * Everything is generated locally: seeded listings use SVG artwork so the
 * marketplace works offline, and match suggestions are produced by the same
 * heuristic engine used at runtime. Run `npm run seed` to reset.
 */

const fs = require('node:fs')
const path = require('node:path')

const { reset, save, SEED_IMAGE_DIR } = require('./store')
const { hashPassword } = require('./auth')
const { buildSvg, artSignature } = require('./svgart')
const { scorePair, THRESHOLDS } = require('./matching')
const { randomId } = require('./util')

const DEMO_PASSWORD = 'demo1234'

// Minimal RVU Mysore users only
const USERS = [
  ['admin', 'admin@rvu.mysore.in', 'Lost N Found Team', 'RVU Mysore', 'admin', DEMO_PASSWORD,
    'Keeping the RVU marketplace safe, kind and tidy.', 40, 0],
  ['aarav', 'aarav@rvu.mysore.in', 'Aarav Sharma', 'RVU Mysore', 'member', DEMO_PASSWORD,
    'Architect, serial key-loser, occasional finder of other people\u2019s things.', 34, 2],
  ['priya', 'priya@rvu.mysore.in', 'Priya Nair', 'RVU Mysore', 'member', DEMO_PASSWORD,
    'Teacher. I walk the same route every morning and pick up what the city drops.', 65, 4],
]

/** Admin account verification */
const ADMIN_USERNAME = 'admin'
const ADMIN_EMAIL = 'admin@rvu.mysore.in'

// Minimal RVU Mysore listings only (all city = RVU Mysore, area = campus locations)
const LISTINGS = [
  ['lost', 'Black leather wallet',
    'Slim black leather wallet with a small tear on the inner pocket. It had my metro card and some cash inside. Last seen near the RVU campus main building.',
    'Wallets & Cards', 'Hidesign', 'black', 'RVU Mysore', 'Central Library, 2nd floor', 9, 'aarav', 'active', 1000,
    'There is a folded movie ticket from Woodlands and a tiny photo tucked behind the card slot.'],

  ['found', 'Black wallet found near the bus stand',
    'Found a black leather wallet on the footpath near the RVU campus bus stand on Tuesday evening. It was slightly wet from the rain. Holding it safely until the owner describes what is inside.',
    'Wallets & Cards', 'Hidesign', 'black', 'RVU Mysore', 'Central Library, 2nd floor', 8, 'priya', 'active', 0,
    'The wallet has a torn inner pocket and a paper ticket folded into the note section.'],

  ['lost', 'Silver iPhone 13, cracked corner',
    'Left my phone on a bench near the RVU campus library while cycling. Silver iPhone 13 with a cracked top-right corner and a dark blue case. Screen lock is on.',
    'Phones & Electronics', 'Apple', 'silver', 'RVU Mysore', 'Central Library, 2nd floor', 12, 'aarav', 'active', 2000,
    'Lock screen shows a photo of a black cycle leaning against a wall.'],

  ['found', 'iPhone found on a park bench',
    'Found a silver iPhone on a bench at the RVU campus library during my morning walk. Cracked corner, blue case. It is charging safely at home.',
    'Phones & Electronics', 'Apple', 'silver', 'RVU Mysore', 'Central Library, 2nd floor', 11, 'priya', 'active', 0,
    'The case has a mountain sticker on the back.'],

  ['lost', 'Blue Nike backpack with a laptop',
    'Navy blue Nike backpack left on the RVU campus platform while I was running for a train. It has a laptop, a charger and a notebook inside.',
    'Bags & Luggage', 'Nike', 'navy', 'RVU Mysore', 'Central Library, 2nd floor', 6, 'priya', 'active', 1500,
    'The notebook has a red cover and there is a train ticket from last month tucked in the front pocket.'],

  ['found', 'Navy backpack at RVU campus',
    'A navy blue backpack was left beside a bench on the RVU campus. I handed the laptop to the station office but kept the bag, since people usually come back for documents first.',
    'Bags & Luggage', 'Nike', 'navy', 'RVU Mysore', 'Central Library, 2nd floor', 5, 'aarav', 'active', 0,
    'The front pocket zipper pull is broken and there is a red notebook inside.'],

  ['lost', 'Brass house keys with a red tag',
    'Three brass keys on a steel ring, one with a red plastic tag. Lost somewhere between the vegetable market and my street in RVU campus. No address written on the tag, thankfully.',
    'Keys', '', 'silver', 'RVU Mysore', 'Central Library, 2nd floor', 15, 'priya', 'active', 0,
    'The red tag has a small chip on one corner and there is a bottle opener on the ring.'],

  ['found', 'Set of keys with a red tag',
    'Found a set of three keys with a red tag near the flower stalls at RVU campus Devaraja Market. Kept with the shopkeeper at the corner so the owner can collect them.',
    'Keys', '', 'silver', 'RVU Mysore', 'Central Library, 2nd floor', 14, 'aarav', 'active', 0,
    'The ring has a bottle opener and the red tag is chipped.'],

  ['lost', 'Black over-ear headphones',
    'Sony over-ear headphones in a black carry case, left in a cab between RVU campus buildings. The left ear cushion has a small tear. The case has my initials written inside.',
    'Audio', 'Sony', 'black', 'RVU Mysore', 'Central Library, 2nd floor', 20, 'priya', 'returned', 0,
    'The carry case has a white marker initial inside the flap.'],

  ['found', 'Headphones left in a cab',
    'The driver of a cab handed me a black headphone case that a passenger left behind. I am posting it here before dropping it at the police station.',
    'Audio', 'Sony', 'black', 'RVU Mysore', 'Central Library, 2nd floor', 19, 'priya', 'returned', 0,
    'The left cushion is torn and there are initials inside the case.'],

  ['lost', 'Titan watch with a brown strap',
    'My father\u2019s Titan watch, brown leather strap, off-white face. Lost at the RVU campus promenade on Sunday evening. It has huge sentimental value.',
    'Watches', 'Titan', 'brown', 'RVU Mysore', 'Central Library, 2nd floor', 10, 'aarav', 'active', 3000,
    'The back of the case is engraved with the letters R.K. and the year 1998.'],

  ['found', 'Brown strap watch at RVU campus',
    'Found a Titan watch with a brown strap on the RVU campus promenade wall near the lighthouse. Face is off-white. Keeping it safe.',
    'Watches', 'Titan', 'brown', 'RVU Mysore', 'Central Library, 2nd floor', 9, 'priya', 'active', 0,
    'The back plate is engraved with two initials and a year.'],

  ['lost', 'Brown folder with certificates',
    'A brown document folder with my degree certificates and a passport photocopy, lost in a yellow taxi between RVU campus buildings. The folder has a black elastic band.',
    'Documents', '', 'brown', 'RVU Mysore', 'Central Library, 2nd floor', 4, 'aarav', 'active', 0,
    'Inside there is a blue folder with an admission letter and a photograph stapled to it.'],

  ['found', 'Document folder in a taxi',
    'The taxi driver handed me a brown folder left on the back seat. Certificates and a photocopy inside. I have not opened it beyond checking that it was not mine.',
    'Documents', '', 'brown', 'RVU Mysore', 'Central Library, 2nd floor', 3, 'priya', 'active', 0,
    'The folder has a black elastic band and a stapled photograph inside.'],

  ['lost', 'Black frame spectacles',
    'Black rectangular spectacles in a soft grey pouch, left in the reading room of the RVU campus library. Prescription lenses.',
    'Eyewear', 'Vincent Chase', 'black', 'RVU Mysore', 'Central Library, 2nd floor', 13, 'priya', 'active', 0,
    'The pouch has a library due-date slip inside it.'],

  ['found', 'Spectacles in a grey pouch',
    'Found a pair of black rectangular spectacles in a grey pouch on a reading table at the RVU campus library. Left with the front desk.',
    'Eyewear', 'Vincent Chase', 'black', 'RVU Mysore', 'Central Library, 2nd floor', 12, 'aarav', 'active', 0,
    'The pouch contains a library slip with a date on it.'],

  ['lost', 'Grey umbrella with a wooden handle',
    'A grey folding umbrella with a wooden handle, left in an auto near RVU campus MG Road. Nothing fancy, but it was a gift.',
    'Umbrellas', '', 'grey', 'RVU Mysore', 'Central Library, 2nd floor', 5, 'priya', 'active', 0,
    'One of the ribs is bent and the wooden handle has a small crack.'],

  ['found', 'Umbrella left in an auto',
    'An auto driver gave me a grey umbrella left on the seat. Wooden handle, slightly bent rib. Happy to hand it over.',
    'Umbrellas', '', 'grey', 'RVU Mysore', 'Central Library, 2nd floor', 4, 'aarav', 'active', 0,
    'The handle has a crack near the base and one rib is bent.'],

  ['lost', 'Red school bag with books',
    'Red school bag with Class 7 textbooks and a lunch box, left at the RVU campus bus stop near the school gate. My daughter is quite upset about the books.',
    'Bags & Luggage', '', 'red', 'RVU Mysore', 'Central Library, 2nd floor', 16, 'priya', 'returned', 0,
    'The lunch box is blue and there is a name written inside the front pocket.'],

  ['found', 'Red school bag at RVU campus bus stop',
    'Found a red school bag at the RVU campus bus stop, kept it with the school office. Textbooks and a blue lunch box inside.',
    'Bags & Luggage', '', 'red', 'RVU Mysore', 'Central Library, 2nd floor', 15, 'aarav', 'returned', 0,
    'There is a name written inside the front pocket with a sketch pen.'],
]

const IMAGE_ASPECTS = [0.78, 0.72, 0.86, 0.68]

function seed(options) {
  const opts = options || {}
  if (!opts.force) {
    const existing = require('./store').getDb()
    if (existing.users.length) {
      console.log('Database already contains data. Run `npm run seed` to rebuild it.')
      return { skipped: true }
    }
  }

  fs.mkdirSync(SEED_IMAGE_DIR, { recursive: true })
  for (const file of fs.readdirSync(SEED_IMAGE_DIR)) {
    if (file.endsWith('.svg')) fs.unlinkSync(path.join(SEED_IMAGE_DIR, file))
  }

  const db = reset()
  const now = Date.now()
  const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString()
  const dateOnly = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString().slice(0, 10)

  const users = []
  for (const [username, email, fullName, city, role, password, bio, reputation, returns] of USERS) {
    const { salt, hash } = hashPassword(password)
    users.push({
      id: randomId('u_'),
      username,
      email,
      fullName,
      avatarUrl: null,
      bio,
      city,
      role,
      salt,
      hash,
      reputation,
      successfulReturns: returns,
      createdAt: iso(150 - users.length * 9),
      prefs: { emailMatches: true, emailMessages: true, emailUpdates: false },
    })
  }
  db.users = users

  const byUsername = new Map(users.map((user) => [user.username, user]))

  // Define shorthand references after byUsername is created
  const aaravUser = byUsername.get('aarav')
  const priyaUser = byUsername.get('priya')

  const listings = []
  LISTINGS.forEach((entry, index) => {
    const [type, title, description, category, brand, color, city, area,
      daysAgo, ownerName, status, reward, privateDetail] = entry
    const owner = byUsername.get(ownerName)
    if (!owner) {
      console.warn(`Owner ${ownerName} not found in users, skipping listing ${index}`)
      return
    }
    const variant = index % 9
    const aspect = IMAGE_ASPECTS[index % IMAGE_ASPECTS.length]
    const count = index % 5 === 0 ? 2 : 1
    const images = []
    for (let imageIndex = 0; imageIndex < count; imageIndex += 1) {
      const height = Math.round(600 / (imageIndex === 0 ? aspect : 0.86))
      const svg = buildSvg(category, variant + imageIndex, height)
      const name = `seed-${index}-${imageIndex}-${variant + imageIndex}.svg`
      fs.writeFileSync(path.join(SEED_IMAGE_DIR, name), svg, 'utf8')
      images.push({
        url: '/uploads/seed/' + name,
        aspect: imageIndex === 0 ? aspect : 0.86,
      })
    }

    listings.push({
      id: randomId('l_'),
      userId: owner.id,
      type,
      title,
      description,
      category,
      brand,
      color,
      city,
      area,
      incidentDate: dateOnly(daysAgo),
      status,
      reward,
      privateDetail,
      images,
      imageSignature: artSignature(category, variant),
      claims: [],
      createdAt: iso(Math.max(0.2, daysAgo - 0.3)),
      returnedAt: status === 'returned' ? iso(Math.max(0.1, daysAgo - 2)) : null,
    })
  })
  db.listings = listings

  /* matches from the real scoring engine */
  const lost = listings.filter((listing) => listing.type === 'lost')
  const found = listings.filter((listing) => listing.type === 'found')
  const matches = []
  for (const lostListing of lost) {
    for (const foundListing of found) {
      const { total, parts } = scorePair(lostListing, foundListing)
      if (total < THRESHOLDS.suggest) continue
      matches.push({
        id: randomId('m_'),
        lostListingId: lostListing.id,
        foundListingId: foundListing.id,
        similarityScore: total,
        parts,
        status: 'suggested',
        createdAt: iso(0.4),
      })
    }
  }
  matches.sort((a, b) => b.similarityScore - a.similarityScore)
  db.matches = matches.slice(0, 140)

  /* conversations about two of the strongest pairs */
  const walletFound = listings.find((listing) => listing.title.startsWith('Black wallet found'))
  const phoneFound = listings.find((listing) => listing.title.startsWith('iPhone found'))
  const conversations = []
  const messages = []

  function addConversation(listing, sender, body, reply) {
    if (!listing) return
    const other = users.find((user) => user.id === listing.userId)
    if (!other) return
    const createdAt = iso(0.9)
    const conversation = {
      id: randomId('c_'),
      listingId: listing.id,
      memberIds: [sender.id, other.id],
      createdAt,
      updatedAt: iso(0.4),
    }
    conversations.push(conversation)
    messages.push({
      id: randomId('msg_'),
      conversationId: conversation.id,
      senderId: sender.id,
      body,
      createdAt,
      readAt: iso(0.7),
    })
    messages.push({
      id: randomId('msg_'),
      conversationId: conversation.id,
      senderId: other.id,
      body: reply,
      createdAt: iso(0.45),
      readAt: null,
    })
  }

  addConversation(walletFound, aaravUser,
    'Hi Priya, I think that is my wallet. Can you tell me what is tucked behind the card slot?',
    'There is a folded ticket and a small photo. That matches what the owner described. Shall we meet near the bus stand tomorrow at 6?')

  addConversation(phoneFound, priyaUser,
    'Hello, that sounds like my phone. The lock screen is a photo of my cycle. Is the case blue with a sticker?',
    'Yes, blue case with a mountain sticker. I am home after 7 most evenings. We can meet at the park gate if that works.')

  db.conversations = conversations
  db.messages = messages

  /* notifications */
  db.notifications = [
    {
      id: randomId('n_'),
      userId: aaravUser.id,
      type: 'match',
      title: 'Strong possible match for your black wallet',
      body: 'Priya Nair reported a found wallet in RVU Mysore. Verify a private detail before arranging a handover.',
      referenceId: db.matches[0] ? db.matches[0].id : null,
      isRead: false,
      createdAt: iso(0.3),
    },
    {
      id: randomId('n_'),
      userId: aaravUser.id,
      type: 'message',
      title: 'New message from Priya Nair',
      body: 'There is a folded ticket and a small photo. That matches what the owner described.',
      referenceId: conversations[0] ? conversations[0].id : null,
      isRead: false,
      createdAt: iso(0.45),
    },
    {
      id: randomId('n_'),
      userId: priyaUser.id,
      type: 'returned',
      title: '"Red school bag with books" is home',
      body: 'Thanks for closing the loop. Your reputation grew by 10 points.',
      referenceId: listings.find((listing) => listing.title.startsWith('Red school bag with'))?.id || null,
      isRead: true,
      createdAt: iso(2.5),
    },
  ]

  /* saved items */
  db.saved = [
    { userId: aaravUser.id, listingId: walletFound.id, createdAt: iso(0.7) },
    { userId: priyaUser.id, listingId: listings.find((listing) => listing.title.startsWith('Brown folder with'))?.id || null, createdAt: iso(1.4) },
  ]

  /* reports for the moderation queue */
  db.reports = [
    {
      id: randomId('r_'),
      reporterId: priyaUser.id,
      listingId: listings.find((listing) => listing.title === 'Brown folder with certificates')?.id || null,
      reason: 'Possible scam or fraud',
      details: 'The same bag was posted last week under a different account and asked for a courier fee.',
      status: 'pending',
      createdAt: iso(1.2),
    },
  ]

  db.meta = {
    seededAt: new Date().toISOString(),
    demoPassword: DEMO_PASSWORD,
    adminPassword: DEMO_PASSWORD,
    matches: db.matches.length,
  }

  save()
  console.log(
    `Seeded ${db.users.length} members, ${db.listings.length} listings, ${db.matches.length} matches, ` +
    `${db.conversations.length} conversations.`
  )
  return db
}

if (require.main === module) {
  seed({ force: process.argv.includes('--force') })
}

// Rebuild one seeded illustration from its filename. Hosts with a read-only or
// ephemeral filesystem never keep public/uploads/seed, so artwork is rendered on
// demand instead of 404ing.
function seedSvgFor(name) {
  const match = /^seed-(\d+)-(\d+)-(\d+)\.svg$/.exec(String(name || ''))
  if (!match) return null
  const index = Number(match[1])
  if (!(index >= 0 && index < LISTINGS.length)) return null
  const imageIndex = Number(match[2])
  const variant = Number(match[3])
  const aspect = imageIndex === 0 ? IMAGE_ASPECTS[index % IMAGE_ASPECTS.length] : 0.86
  return buildSvg(LISTINGS[index][3], variant, Math.round(600 / aspect))
}

module.exports = { seed, seedSvgFor }