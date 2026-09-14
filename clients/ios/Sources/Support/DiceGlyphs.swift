import Foundation

/// Presentation helpers. No rules — just how to say things out loud.
extension Face {
    /// The Unicode die face. Phase 4 replaces these with drawn dice; for now they are legible
    /// and cost nothing.
    var glyph: String {
        switch self {
        case .one: "⚀"
        case .two: "⚁"
        case .three: "⚂"
        case .four: "⚃"
        case .five: "⚄"
        case .six: "⚅"
        }
    }

    var spoken: String {
        switch self {
        case .one: "ones"
        case .two: "twos"
        case .three: "threes"
        case .four: "fours"
        case .five: "fives"
        case .six: "sixes"
        }
    }
}

extension Bid {
    /// "4 × ⚄" — compact enough for a bid history row.
    var short: String { "\(quantity) × \(face.glyph)" }

    var spoken: String { "\(quantity) \(face.spoken)" }
}

extension ProtocolEvent {
    /// A one-line description for the event feed. Deliberately plain: Phase 4 turns these into
    /// animations, and until then reading them is how you tell the client is keeping up.
    var summary: String {
        switch self {
        case .matchStarted(let event):
            "Match started — \(event.playerIds.count) players, \(event.startingDice) dice each"
        case .roundStarted(let event):
            event.palifico
                ? "Round \(event.index + 1): PALIFICO, \(event.starterId) opens"
                : "Round \(event.index + 1): \(event.starterId) opens"
        case .bidMade(let event):
            "\(event.playerId) bids \(event.bid.spoken)"
        case .dudoCalled(let event):
            "\(event.playerId) calls dudo on \(event.bidderId)'s \(event.bid.spoken)"
        case .diceRevealed(let event):
            "Revealed: \(event.reveal.actualCount) × \(event.reveal.bid.face.glyph)"
                + (event.reveal.bidStands ? " — the bid was good" : " — the bid was a lie")
        case .dieLost(let event):
            "\(event.playerId) loses a die — \(event.diceCount) left"
        case .playerEliminated(let event):
            "\(event.playerId) is out"
        case .palificoArmed(let event):
            "\(event.playerId) is down to one die — next round is palifico"
        case .matchEnded(let event):
            "\(event.winnerId) wins"
        case .turnStarted(let event):
            "\(event.playerId) to act"
        case .playerTimedOut(let event):
            event.autoBid == nil
                ? "\(event.playerId) timed out again"
                : "\(event.playerId) ran out of time — auto-bid played"
        case .playerDisconnected(let event):
            "\(event.playerId) disconnected"
        case .playerReconnected(let event):
            "\(event.playerId) is back"
        case .botTookOver(let event):
            "A bot is playing \(event.playerId)'s seat (\(event.reason.rawValue))"
        case .controlReturned(let event):
            "\(event.playerId) has their seat back"
        case .matchAbandoned:
            "Match abandoned — everyone left"
        }
    }
}

extension ErrorCode {
    /// What to put in front of a player when the server refuses something.
    var readable: String {
        switch self {
        case .bidTooLow: "That bid does not raise the current one."
        case .bidExceedsDiceInPlay: "There are not that many dice on the table."
        case .bidQuantityInvalid: "That is not a valid quantity."
        case .bidFaceInvalid: "That is not a valid face."
        case .palificoFaceLocked: "The face is locked for this palifico round."
        case .openingBidRequired: "You open the round, so you have to bid."
        case .notYourTurn: "It is not your turn."
        case .playerEliminated: "You are out of this match."
        case .matchEnded: "The match is over."
        case .seatNotYours: "A bot is playing your seat."
        case .rateLimited: "Slow down a moment."
        default: "The server refused that: \(rawValue)"
        }
    }
}
