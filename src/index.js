// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://1f6a1423e0d848488ebf4cb47d017aa6:2cbb42f7f8c6465bb620509006769435@sentry.cozycloud.cc/76'

const cheerio = require('cheerio')
const {
  BaseKonnector,
  requestFactory,
  scrape,
  saveBills,
  log,
  errors,
  createCozyPDFDocument,
  htmlToPDF
} = require('cozy-konnector-libs')

const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very usefull for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: false,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: true,
  // this allows request-promise to keep cookies between requests
  jar: true
})

const ordersURL = `https://www.nespresso.com/fr/fr/myaccount/orders`

module.exports = new BaseKonnector(start)
// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  // The BaseKonnector instance expects a Promise as return of the function
  log('info', 'Fetching the list of documents')
  const $ = cheerio.load(await request(`${ordersURL}/changeList?number=100`))

  // cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)

  for (var i = 0; i < documents.length; i++) {
    const doc = documents[i]
    const $doc = cheerio.load(await request(doc.fileurl))
    var pdf = createCozyPDFDocument(
      'Généré par le collecteur Cozy',
      doc.fileurl
    )

    // Clean the html
    $doc(
      '.my-order-delivery, #einvoice-summary, #confirm-reorder-dialog, .my-order-ordering-origin, caption'
    ).remove()

    htmlToPDF($doc, pdf, $doc('.my-order-details'), { baseURL: doc.fileurl })
    doc.filestream = pdf
    doc.filestream.end()
    delete doc.fileurl
  }

  // // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // // common case in connectors
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields.folderPath, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['nespresso'],
    contentType: 'application/pdf'
  })
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
async function authenticate(username, password) {
  try {
    const body = await request({
      url: `https://www.nespresso.com/mosaic/fr/en/ecapi/1/authentication/login`,
      method: 'POST',
      form: {
        j_username: username,
        j_password: password,
        _spring_security_remember_me: 'false'
      }
    })
    return body
  } catch (err) {
    if (err.statusCode === 401) {
      throw new Error(errors.LOGIN_FAILED)
    } else {
      log('error', err.message)
      throw new Error(errors.VENDOR_DOWN)
    }
  }
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
function parseDocuments($) {
  // you can find documentation about the scrape function here :
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    $,
    {
      number: {
        sel: '.my-orders-list__order .my-orders-list__cell--description'
      },
      amount: {
        sel: '.my-orders-list__amount .my-orders-list__cell--description',
        parse: normalizePrice
      },
      date: {
        sel: '.my-orders-list__date .my-orders-list__cell--description',
        parse: normalizeDate
      },
      status: {
        sel: '.my-orders-list__status .my-orders-list__cell--description'
      },
      fileurl: {
        sel: '.my-orders-list__actions .my-orders-list__cell--description a',
        attr: 'href',
        parse: path => `${ordersURL}/${path}`
      }
    },
    '.my-orders-list .my-orders-list__row-content'
  )

  return docs.map(doc => ({
    ...doc,
    // the saveBills function needs a date field
    // even if it is a little artificial here (these are not real bills)
    currency: 'EUR',
    vendor: 'nespresso',
    filename: doc.number + '.pdf',
    metadata: {
      // it can be interesting that we add the date of import. This is not mandatory but may be
      // usefull for debugging or data migration
      importDate: new Date(),
      // document version, usefull for migration after change of document structure
      version: 1
    }
  }))
}

// convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.replace(',', '.').trim())
}

function normalizeDate(str) {
  const parts = str.split('/')
  return new Date(
    parseInt(parts[2], 10),
    parseInt(parts[1], 10) - 1,
    parseInt(parts[0], 10)
  )
}
